create or replace function public.vector_enforce_agent_ownership()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  row_data jsonb := to_jsonb(new);
begin
  if tg_table_name = 'vector_agent_runs' and nullif(row_data ->> 'team_id', '') is not null then
    if not exists (
      select 1
        from public.vector_agent_teams
       where id = (row_data ->> 'team_id')::uuid
         and user_id = (row_data ->> 'user_id')::uuid
    ) then
      raise exception 'Agent team ownership mismatch';
    end if;
  elsif tg_table_name = 'vector_agent_messages' then
    if not exists (
      select 1
        from public.vector_agent_runs
       where id = (row_data ->> 'run_id')::uuid
         and user_id = (row_data ->> 'user_id')::uuid
    ) then
      raise exception 'Agent run ownership mismatch';
    end if;
  end if;
  return new;
end;
$$;
