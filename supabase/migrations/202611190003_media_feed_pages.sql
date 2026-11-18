begin;

-- Old clients continue to use get_feed_page. This query only reads published
-- posts and the capture objects visible under the caller's storage policies.
create function public.get_media_feed_page(
  p_mode text default 'all', p_media text default 'all', p_search text default '',
  p_cursor_at timestamptz default null, p_cursor_id uuid default null, p_post uuid default null
)
returns table(
  id uuid, user_id uuid, caption text, image_path text, created_at timestamptz,
  captured_at timestamptz, platform text, username text, display_name text,
  like_count bigint, comment_count bigint, liked boolean, saved boolean, following boolean, media_type text
)
language plpgsql stable security invoker set search_path = '' as $$
begin
  if (p_cursor_at is null) <> (p_cursor_id is null) then
    raise exception 'INVALID_FEED_CURSOR' using errcode='22023';
  end if;
  if p_media is null or p_media not in ('all','photo','video') then
    raise exception 'INVALID_FEED_MEDIA' using errcode='22023';
  end if;

  return query
  with candidates as (
    select p.id, p.user_id, p.caption, p.image_path, p.created_at, p.captured_at, p.platform,
      u.username, u.display_name,
      exists(select 1 from public.bookmarks b where b.post_id=p.id and b.user_id=(select auth.uid())) as is_saved,
      exists(select 1 from public.follows f where f.following_id=p.user_id and f.follower_id=(select auth.uid())) as is_following,
      case
        when mime.value in ('image/jpeg','image/png','image/webp','image/avif','image/gif') then 'photo'
        when mime.value in ('video/mp4','video/webm','video/quicktime','video/ogg') then 'video'
        when mime.value in ('','application/octet-stream') then
          case
            when o.name ~* '[.](jpe?g|png|webp|avif|gif)$' then 'photo'
            when o.name ~* '[.](mp4|webm|mov|ogv)$' then 'video'
          end
      end as kind
    from public.posts p
    join public.profiles u on u.id=p.user_id
    join storage.objects o on o.bucket_id='captures' and o.name=p.image_path
    cross join lateral (select lower(trim(split_part(coalesce(o.metadata->>'mimetype',''),';',1))) as value) mime
    where (select auth.uid()) is not null
      and (p_post is null or p.id=p_post)
      and (p_cursor_at is null or (p.created_at,p.id)<(p_cursor_at,p_cursor_id))
      and (p_search='' or strpos(lower(p.caption),lower(left(p_search,80)))>0
        or strpos(lower(u.display_name),lower(left(p_search,80)))>0
        or strpos('@' || u.username,lower(left(p_search,80)))>0)
  )
  select c.id, c.user_id, c.caption, c.image_path, c.created_at, c.captured_at, c.platform,
    c.username, c.display_name,
    (select count(*) from public.likes l where l.post_id=c.id),
    (select count(*) from public.comments cm where cm.post_id=c.id),
    exists(select 1 from public.likes l where l.post_id=c.id and l.user_id=(select auth.uid())),
    c.is_saved, c.is_following, c.kind
  from candidates c
  where c.kind is not null and (p_media='all' or c.kind=p_media)
    and (p_mode='all' or (p_mode='profile' and c.user_id=(select auth.uid()))
      or (p_mode='saved' and c.is_saved) or (p_mode='following' and c.is_following))
  order by c.created_at desc,c.id desc
  limit 21;
end; $$;

revoke all on function public.get_media_feed_page from public, anon;
grant execute on function public.get_media_feed_page to authenticated;

commit;
