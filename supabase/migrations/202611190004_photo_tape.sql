begin;

alter table public.posts add column tape text check (tape in ('top','center','bottom'));

create or replace function public.finish_capture_publication(p_id uuid,p_user uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare r public.capture_publications; l jsonb; ref uuid;
begin
  select * into r from public.capture_publications where challenge_id=p_id and user_id=p_user for update;
  if not found then raise exception 'Capture unavailable'; end if;
  if r.state='published' then return r.post_id; end if;
  if r.state<>'pending' or r.expires_at<=now() then raise exception 'Capture unavailable'; end if;
  ref := (r.context->>'referencePostId')::uuid;
  -- A removed source never prevents publishing the member's own new photograph.
  select id into ref from public.posts where id=ref;
  insert into public.posts(id,user_id,image_path,image_sha256,caption,platform,captured_at,photo_filter,reference_post_id,tape)
    values(r.post_id,r.user_id,r.image_path,r.image_sha256,r.caption,r.platform,r.captured_at,
      coalesce(r.context->>'filter','original'),ref,r.context->>'tape');
  l := r.context->'place';
  if l is not null and l<>'null'::jsonb then
    insert into public.photo_places(post_id,user_id,latitude,longitude,label,audience)
      values(r.post_id,r.user_id,(l->>'latitude')::numeric,(l->>'longitude')::numeric,l->>'label',l->>'audience');
  end if;
  update public.capture_publications set state='published' where challenge_id=p_id;
  return r.post_id;
end; $$;

drop function public.get_photo_details(uuid[]);
create function public.get_photo_details(p_ids uuid[])
returns table(post_id uuid,photo_filter text,reference_post_id uuid,latitude numeric,longitude numeric,label text,audience text,tape text)
language sql stable security invoker set search_path = '' as $$
  select p.id,p.photo_filter,p.reference_post_id,l.latitude,l.longitude,l.label,l.audience,p.tape
    from public.posts p left join public.photo_places l on l.post_id=p.id
    where p.id=any(p_ids[1:40]);
$$;
revoke all on function public.get_photo_details(uuid[]) from public,anon;
grant execute on function public.get_photo_details(uuid[]) to authenticated;

drop function public.resolve_post_share(text);
create function public.resolve_post_share(p_token text)
returns table (image_path text, caption text, mime_type text, tape text)
language sql stable security definer set search_path = '' as $$
  select p.image_path, p.caption, lower(o.metadata->>'mimetype'), p.tape
  from public.post_share_links l
  join public.posts p on p.id = l.post_id
  join storage.objects o on o.bucket_id = 'captures' and o.name = p.image_path
  where l.token = p_token;
$$;
revoke all on function public.resolve_post_share(text) from public,anon,authenticated;
grant execute on function public.resolve_post_share(text) to service_role;

create or replace view public.work_stack_sources_private as
  select p.user_id,'post'::text as source,p.id,p.caption,p.created_at,p.image_path,
    case when lower(o.metadata->>'mimetype') like 'video/%' then 'video' else 'photo' end as media_kind,
    encode(sha256(convert_to(l.token,'UTF8')),'hex') as link_key,l.token as credential,p.tape
  from public.posts p
  left join public.post_share_links l on l.post_id=p.id
  left join storage.objects o on o.bucket_id='captures' and o.name=p.image_path
  union all
  select c.user_id,'certificate',c.id,''::text,c.created_at,null::text,c.media_kind,c.share_hash,c.share_nonce,null::text
  from public.media_certificates c where c.state in ('queued','minted');

create or replace function public.work_stack_source_json(r public.work_stack_sources_private, included boolean)
returns jsonb language sql stable set search_path='' as $$
  select jsonb_build_object('source',r.source,'id',r.id,'caption',r.caption,'createdAt',r.created_at,
    'imagePath',r.image_path,'mediaKind',r.media_kind,'shared',r.link_key is not null,'inShare',coalesce(included,false))
    || case when r.tape is null then '{}'::jsonb else jsonb_build_object('tape',r.tape) end;
$$;

create or replace function public.resolve_work_stack(p_token text,p_item uuid default null)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('title',s.title,'items',coalesce((
    select jsonb_agg(jsonb_build_object('id',i.id,'source',r.source,'mediaKind',r.media_kind,'caption',r.caption)
      || case when r.tape is null then '{}'::jsonb else jsonb_build_object('tape',r.tape) end
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

commit;
