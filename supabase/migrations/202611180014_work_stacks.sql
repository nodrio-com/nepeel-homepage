begin;

create table public.work_stacks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 80),
  revision integer not null default 1,
  updated_at timestamptz not null default now(),
  share_token text unique check (share_token ~ '^[A-Za-z0-9_-]{43}$')
);
create index work_stacks_owner_idx on public.work_stacks(user_id,updated_at desc,id desc);

create table public.work_stack_items (
  id uuid primary key default gen_random_uuid(),
  stack_id uuid not null references public.work_stacks(id) on delete cascade,
  post_id uuid references public.posts(id) on delete cascade,
  certificate_id uuid references public.media_certificates(id) on delete cascade,
  source text generated always as (case when post_id is not null then 'post' else 'certificate' end) stored,
  source_id uuid generated always as (coalesce(post_id,certificate_id)) stored,
  position integer not null check (position between 1 and 100),
  -- Bind inclusion to the specific individual grant the owner approved.
  link_key text check (link_key ~ '^[0-9a-f]{64}$'),
  check (num_nonnulls(post_id,certificate_id)=1),
  unique (stack_id,source,source_id)
);
create index work_stack_items_post_idx on public.work_stack_items(post_id) where post_id is not null;
create index work_stack_items_cert_idx on public.work_stack_items(certificate_id) where certificate_id is not null;
alter table public.work_stacks enable row level security;
alter table public.work_stack_items enable row level security;
revoke all on public.work_stacks,public.work_stack_items from public,anon,authenticated,service_role;

-- Private join used only by the narrowly scoped functions below.
create view public.work_stack_sources_private as
  select p.user_id,'post'::text as source,p.id,p.caption,p.created_at,p.image_path,
    case when lower(o.metadata->>'mimetype') like 'video/%' then 'video' else 'photo' end as media_kind,
    encode(sha256(convert_to(l.token,'UTF8')),'hex') as link_key,l.token as credential
  from public.posts p
  left join public.post_share_links l on l.post_id=p.id
  left join storage.objects o on o.bucket_id='captures' and o.name=p.image_path
  union all
  select c.user_id,'certificate',c.id,''::text,c.created_at,null::text,c.media_kind,c.share_hash,c.share_nonce
  from public.media_certificates c where c.state in ('queued','minted');
revoke all on public.work_stack_sources_private from public,anon,authenticated,service_role;

create function public.work_stack_source_json(r public.work_stack_sources_private, included boolean)
returns jsonb language sql stable set search_path='' as $$
  select jsonb_build_object('source',r.source,'id',r.id,'caption',r.caption,'createdAt',r.created_at,
    'imagePath',r.image_path,'mediaKind',r.media_kind,'shared',r.link_key is not null,'inShare',coalesce(included,false));
$$;

create function public.work_stack_owner_data(p_stack uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('id',s.id,'title',s.title,'revision',s.revision,'shareToken',s.share_token,
    'items',coalesce((select jsonb_agg(public.work_stack_source_json(r,s.share_token is not null and i.link_key=r.link_key)
      order by i.position)
      from public.work_stack_items i join public.work_stack_sources_private r
        on (r.user_id,r.source,r.id)=(s.user_id,i.source,i.source_id)
      where i.stack_id=s.id),'[]'::jsonb))
  from public.work_stacks s where s.id=p_stack and s.user_id=auth.uid();
$$;

create function public.list_work_stacks()
returns setof jsonb language sql stable security definer set search_path='' as $$
  select public.work_stack_owner_data(s.id) from public.work_stacks s
  where s.user_id=auth.uid() order by s.updated_at desc,s.id desc limit 100;
$$;

create function public.list_work_stack_sources(p_before_at timestamptz default null,
  p_before_id uuid default null,p_before_source text default null)
returns setof jsonb language sql stable security definer set search_path='' as $$
  select public.work_stack_source_json(r,false) from public.work_stack_sources_private r
  where r.user_id=auth.uid() and (p_before_at is null or
    (r.created_at,r.id,r.source)<(p_before_at,p_before_id,p_before_source))
  order by r.created_at desc,r.id desc,r.source desc limit 41;
$$;

create function public.save_work_stack(p_stack uuid,p_title text,p_items jsonb,p_revision integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  owner_id uuid := auth.uid();
  target uuid := coalesce(p_stack,gen_random_uuid());
  stack_row public.work_stacks;
  item_count integer;
  stored_items jsonb;
begin
  if owner_id is null or not public.is_active_member() then raise exception '로그인이 필요해요.' using errcode='42501'; end if;
  if p_title is null or char_length(btrim(p_title)) not between 1 and 80 then
    raise exception '묶음 이름은 1~80자로 입력해 주세요.' using errcode='22023';
  end if;
  if p_items is null or jsonb_typeof(p_items)<>'array' then raise exception '항목을 확인해 주세요.' using errcode='22023'; end if;
  if jsonb_array_length(p_items)>100 then raise exception '한 묶음에 최대 100개를 담을 수 있어요.' using errcode='22023'; end if;
  if p_revision is null then perform pg_advisory_xact_lock(hashtextextended(owner_id::text,14)); end if;
  select * into stack_row from public.work_stacks where id=target and user_id=owner_id for update;
  if p_revision is null and found then
    -- Only the original, identical create may be replayed with its client-generated id.
    select coalesce(jsonb_agg(jsonb_build_object('id',source_id,'source',source) order by position),'[]'::jsonb)
      into stored_items from public.work_stack_items where stack_id=target;
    if stack_row.revision=1 and stack_row.title=btrim(p_title) and p_items=stored_items then
      return public.work_stack_owner_data(target);
    end if;
    raise exception '이미 저장된 묶음이에요. 새로고침해 주세요.' using errcode='40001';
  elsif p_revision is null then
    if (select count(*) from public.work_stacks where user_id=owner_id)>=100 then
      raise exception '묶음을 최대 100개까지 만들 수 있어요.' using errcode='22023';
    end if;
    insert into public.work_stacks(id,user_id,title) values(target,owner_id,btrim(p_title)) returning * into stack_row;
  elsif stack_row.id is null then
    raise exception '묶음을 찾을 수 없어요.' using errcode='42501';
  elsif stack_row.revision<>p_revision then
    raise exception '다른 곳에서 묶음이 바뀌었어요. 새로고침해 주세요.' using errcode='40001';
  else
    update public.work_stacks set title=btrim(p_title),revision=revision+1,updated_at=now() where id=target;
  end if;
  if exists (select 1 from jsonb_array_elements(p_items) as d(entry)
    group by entry->>'source',entry->>'id' having count(*)>1) then
    raise exception '같은 항목은 한 번만 담을 수 있어요.' using errcode='22023';
  end if;

  delete from public.work_stack_items i where i.stack_id=target and not exists
    (select 1 from jsonb_array_elements(p_items) as d(entry)
     where entry->>'source'=i.source and (entry->>'id')::uuid=i.source_id);
  insert into public.work_stack_items(stack_id,post_id,certificate_id,position,link_key)
    select target,case when r.source='post' then r.id end,case when r.source='certificate' then r.id end,
      d.n,case when stack_row.share_token is not null then r.link_key end
    from jsonb_array_elements(p_items) with ordinality as d(entry,n)
    join public.work_stack_sources_private r on r.user_id=owner_id and r.source=d.entry->>'source' and r.id=(d.entry->>'id')::uuid
    -- Existing positions change without repinning individual grants, including revoked ones.
    on conflict (stack_id,source,source_id) do update set position=excluded.position;
  get diagnostics item_count = row_count;
  if item_count<>jsonb_array_length(p_items) then raise exception '내 촬영 기록에서 항목을 골라 주세요.' using errcode='42501'; end if;
  return public.work_stack_owner_data(target);
end; $$;

create function public.set_work_stack_share(p_stack uuid,p_enabled boolean,p_revision integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.work_stacks;
begin
  select * into s from public.work_stacks where id=p_stack and user_id=auth.uid() for update;
  if not found then raise exception '묶음을 찾을 수 없어요.' using errcode='42501'; end if;
  if s.revision is distinct from p_revision then raise exception '다른 곳에서 묶음이 바뀌었어요. 새로고침해 주세요.' using errcode='40001'; end if;
  if p_enabled is null then raise exception '공유 상태를 확인해 주세요.' using errcode='22023'; end if;
  if p_enabled then
    update public.work_stack_items i set link_key=r.link_key from public.work_stack_sources_private r
      where i.stack_id=s.id and (r.user_id,r.source,r.id)=(s.user_id,i.source,i.source_id);
    if not exists(select 1 from public.work_stack_items where stack_id=s.id and link_key is not null) then
      raise exception '공개할 항목의 공유를 먼저 켜 주세요.' using errcode='22023';
    end if;
    s.share_token := coalesce(s.share_token,translate(encode(sha256(uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid())),'base64'),'+/=','-_'));
  else
    update public.work_stack_items set link_key=null where stack_id=s.id;
    s.share_token := null;
  end if;
  update public.work_stacks set share_token=s.share_token,revision=revision+1,updated_at=now() where id=s.id;
  return public.work_stack_owner_data(s.id);
end; $$;

-- The public handler receives only visible items. Credentials are returned solely
-- for a requested member, used server-side by the existing individual-share gate.
create function public.resolve_work_stack(p_token text,p_item uuid default null)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('title',s.title,'items',coalesce((
    select jsonb_agg(jsonb_build_object('id',i.id,'source',r.source,'mediaKind',r.media_kind,'caption',r.caption)
      || case when p_item is null then '{}'::jsonb else jsonb_build_object('sourceId',r.id,'credential',r.credential) end
      order by i.position)
    from public.work_stack_items i join public.work_stack_sources_private r
      on (r.user_id,r.source,r.id,r.link_key)=(s.user_id,i.source,i.source_id,i.link_key)
    where i.stack_id=s.id and (p_item is null or i.id=p_item)
  ),'[]'::jsonb))
  from public.work_stacks s where s.share_token=p_token;
$$;

revoke all on function public.work_stack_source_json,public.work_stack_owner_data,public.list_work_stacks,
  public.list_work_stack_sources,public.save_work_stack,public.set_work_stack_share,public.resolve_work_stack
  from public,anon,authenticated,service_role;
grant execute on function public.list_work_stacks,public.list_work_stack_sources,public.save_work_stack,public.set_work_stack_share to authenticated;
grant execute on function public.resolve_work_stack to service_role;
commit;
