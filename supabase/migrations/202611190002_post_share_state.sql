begin;

create function public.has_own_post_share_link(p_post uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists (
    select 1 from public.post_share_links l
    join public.posts p on p.id=l.post_id
    where p.id=p_post and p.user_id=auth.uid()
  );
$$;
revoke all on function public.has_own_post_share_link(uuid) from public,anon,authenticated,service_role;
grant execute on function public.has_own_post_share_link(uuid) to authenticated;

commit;
