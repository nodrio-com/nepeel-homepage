begin;

-- Existing memberships keep their individual-link pins. Explicit selection can
-- authorize a private source in just this stack, without issuing a standalone URL.
alter table public.work_stacks add column explicit_selection boolean not null default false;
alter table public.work_stack_items add column scoped_grant uuid,
  add constraint work_stack_one_grant check (num_nonnulls(link_key,scoped_grant)<=1);

create or replace function public.work_stack_owner_data(p_stack uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('id',s.id,'title',s.title,'revision',s.revision,'shareToken',s.share_token,
    'items',coalesce((select jsonb_agg(public.work_stack_source_json(r,
        s.share_token is not null and (i.scoped_grant is not null or i.link_key=r.link_key)) order by i.position)
      from public.work_stack_items i join public.work_stack_sources_private r
        on (r.user_id,r.source,r.id)=(s.user_id,i.source,i.source_id)
      where i.stack_id=s.id),'[]'::jsonb))
  from public.work_stacks s where s.id=p_stack and s.user_id=auth.uid();
$$;

-- A normal save can reorder existing grants, but new memberships start private.
create or replace function public.save_work_stack(p_stack uuid,p_title text,p_items jsonb,p_revision integer)
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
  insert into public.work_stack_items(stack_id,post_id,certificate_id,position)
    select target,case when r.source='post' then r.id end,case when r.source='certificate' then r.id end,
      d.n
    from jsonb_array_elements(p_items) with ordinality as d(entry,n)
    join public.work_stack_sources_private r on r.user_id=owner_id and r.source=d.entry->>'source' and r.id=(d.entry->>'id')::uuid
    -- Existing positions change without repinning individual grants, including revoked ones.
    on conflict (stack_id,source,source_id) do update set position=excluded.position;
  get diagnostics item_count = row_count;
  if item_count<>jsonb_array_length(p_items) then raise exception '내 촬영 기록에서 항목을 골라 주세요.' using errcode='42501'; end if;
  return public.work_stack_owner_data(target);
end; $$;

-- Older clients retain the original enable operation for legacy stacks. Once
-- an owner chooses a subset, only an explicit selection may issue new grants.
create or replace function public.set_work_stack_share(p_stack uuid,p_enabled boolean,p_revision integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.work_stacks;
begin
  select * into s from public.work_stacks where id=p_stack and user_id=auth.uid() for update;
  if not found then raise exception '묶음을 찾을 수 없어요.' using errcode='42501'; end if;
  if s.revision is distinct from p_revision then raise exception '다른 곳에서 묶음이 바뀌었어요. 새로고침해 주세요.' using errcode='40001'; end if;
  if p_enabled is null then raise exception '공유 상태를 확인해 주세요.' using errcode='22023'; end if;
  if p_enabled and s.explicit_selection then
    raise exception '공개할 항목을 다시 선택해 주세요.' using errcode='22023';
  end if;
  if p_enabled then
    update public.work_stack_items i set link_key=r.link_key from public.work_stack_sources_private r
      where i.stack_id=s.id and (r.user_id,r.source,r.id)=(s.user_id,i.source,i.source_id);
    if not exists(select 1 from public.work_stack_items where stack_id=s.id and link_key is not null) then
      raise exception '공개할 항목의 공유를 먼저 켜 주세요.' using errcode='22023';
    end if;
    s.share_token := coalesce(s.share_token,translate(encode(sha256(uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid())),'base64'),'+/=','-_'));
  else
    update public.work_stack_items set link_key=null,scoped_grant=null where stack_id=s.id;
    s.share_token := null;
  end if;
  update public.work_stacks set share_token=s.share_token,revision=revision+1,updated_at=now() where id=s.id;
  return public.work_stack_owner_data(s.id);
end; $$;

create function public.publish_work_stack_selection(p_stack uuid,p_selected jsonb,p_revision integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  s public.work_stacks;
  selected_count integer;
begin
  select * into s from public.work_stacks where id=p_stack and user_id=auth.uid() for update;
  if not found then raise exception '묶음을 찾을 수 없어요.' using errcode='42501'; end if;
  if s.revision is distinct from p_revision then
    raise exception '다른 곳에서 묶음이 바뀌었어요. 새로고침해 주세요.' using errcode='40001';
  end if;
  if p_selected is null or jsonb_typeof(p_selected)<>'array' then
    raise exception '공개할 항목을 확인해 주세요.' using errcode='22023';
  end if;
  if jsonb_array_length(p_selected) not between 1 and 100 then
    raise exception '공개할 항목을 1~100개 골라 주세요.' using errcode='22023';
  end if;

  -- Exact JSON reference equality rejects wrong types, duplicates, stale or
  -- foreign members. Failing the count rolls back every grant in this call.
  update public.work_stack_items i set
    link_key=case when i.scoped_grant is null then r.link_key end,
    scoped_grant=case when i.scoped_grant is not null or r.link_key is null then coalesce(i.scoped_grant,gen_random_uuid()) end
    from public.work_stack_sources_private r
    where i.stack_id=s.id and (r.user_id,r.source,r.id)=(s.user_id,i.source,i.source_id)
      and exists (select 1 from jsonb_array_elements(p_selected) as d(entry)
        where d.entry=jsonb_build_object('source',r.source,'id',r.id));
  get diagnostics selected_count = row_count;
  if selected_count<>jsonb_array_length(p_selected) then
    raise exception '이 묶음에서 공개할 항목을 다시 골라 주세요.' using errcode='22023';
  end if;
  update public.work_stack_items i set link_key=null,scoped_grant=null where i.stack_id=s.id
    and not exists (select 1 from jsonb_array_elements(p_selected) as d(entry)
      where d.entry=jsonb_build_object('source',i.source,'id',i.source_id));
  update public.work_stacks set share_token=coalesce(s.share_token,
      translate(encode(sha256(uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid())),'base64'),'+/=','-_')),
    explicit_selection=true,revision=revision+1,updated_at=now() where id=s.id;
  return public.work_stack_owner_data(s.id);
end; $$;

-- When an owner withdraws or rotates source sharing, invalidate affected
-- selections and stale editors. Lock stacks in order just as publishing does.
create function public.revoke_work_stack_source() returns trigger
language plpgsql security definer set search_path='' as $$
declare
  item_source text := tg_argv[0];
  item_id uuid;
  target uuid;
begin
  if item_source='post' then item_id := old.post_id; else item_id := old.id; end if;
  for target in select s.id from public.work_stacks s where exists (
    select 1 from public.work_stack_items i where i.stack_id=s.id and (i.source,i.source_id)=(item_source,item_id)
  ) order by s.id for update of s loop
    -- Invalidate old revisions even before the first explicit selection. A
    -- stale editor of a legacy stack must not restore a just-revoked source.
    update public.work_stack_items set link_key=null,scoped_grant=null
      where stack_id=target and (source,source_id)=(item_source,item_id)
      and (link_key is not null or scoped_grant is not null);
    if found then update public.work_stacks set revision=revision+1,updated_at=now() where id=target; end if;
  end loop;
  return null;
end; $$;

create trigger stack_post_revoke after delete on public.post_share_links
  for each row execute function public.revoke_work_stack_source('post');
create trigger stack_post_rotate after update of token on public.post_share_links
  for each row when (old.token is distinct from new.token) execute function public.revoke_work_stack_source('post');
create trigger stack_certificate_revoke after update of share_hash on public.media_certificates
  for each row when (old.share_hash is not null and old.share_hash is distinct from new.share_hash)
  execute function public.revoke_work_stack_source('certificate');

create or replace function public.resolve_work_stack(p_token text,p_item uuid default null)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('title',s.title,'items',coalesce((
    select jsonb_agg(jsonb_build_object('id',i.id,'source',r.source,'mediaKind',r.media_kind,'caption',r.caption)
      || case when p_item is null then '{}'::jsonb
        when i.scoped_grant is null then jsonb_build_object('sourceId',r.id,'credential',r.credential)
        else jsonb_build_object('sourceId',r.id,'credential',i.scoped_grant,'stackScoped',true)
          || case when i.source='post' then jsonb_build_object('imagePath',r.image_path,'mimeType',
            (select lower(o.metadata->>'mimetype') from storage.objects o where o.bucket_id='captures' and o.name=r.image_path))
            else '{}'::jsonb end end
      order by i.position)
    from public.work_stack_items i join public.work_stack_sources_private r
      on (r.user_id,r.source,r.id)=(s.user_id,i.source,i.source_id)
    where i.stack_id=s.id and (p_item is null or i.id=p_item)
      and (i.scoped_grant is not null or i.link_key=r.link_key)
  ),'[]'::jsonb))
  from public.work_stacks s where s.share_token=p_token;
$$;

revoke all on function public.publish_work_stack_selection,public.revoke_work_stack_source
  from public,anon,authenticated,service_role;
grant execute on function public.publish_work_stack_selection to authenticated;

commit;
