alter table public.vector_agent_runs
  add column if not exists project_id uuid references public.vector_agent_projects(id) on delete cascade,
  add column if not exists preview_command_id text,
  add column if not exists preview_url text,
  add column if not exists preview_port integer,
  add column if not exists preview_status text not null default 'idle';

update public.vector_agent_runs as run
   set project_id = task.project_id
  from public.vector_agent_teams as task
 where run.team_id = task.id
   and run.project_id is null
   and task.project_id is not null;

alter table public.vector_agent_runs
  drop constraint if exists vector_agent_runs_preview_status_check;
alter table public.vector_agent_runs
  add constraint vector_agent_runs_preview_status_check
  check (preview_status in ('idle', 'launching', 'ready', 'failed'));

create index if not exists vector_agent_runs_project_updated_idx
  on public.vector_agent_runs(project_id, updated_at desc);

create or replace function public.vector_enforce_agent_ownership()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  row_data jsonb := to_jsonb(new);
begin
  if tg_table_name = 'vector_agent_teams' and nullif(row_data ->> 'project_id', '') is not null then
    if not exists (
      select 1
        from public.vector_agent_projects
       where id = (row_data ->> 'project_id')::uuid
         and user_id = (row_data ->> 'user_id')::uuid
    ) then
      raise exception 'Agent project ownership mismatch';
    end if;
  elsif tg_table_name = 'vector_agent_runs' and nullif(row_data ->> 'project_id', '') is not null then
    if not exists (
      select 1
        from public.vector_agent_projects
       where id = (row_data ->> 'project_id')::uuid
         and user_id = (row_data ->> 'user_id')::uuid
    ) then
      raise exception 'Builder project ownership mismatch';
    end if;
  elsif tg_table_name = 'vector_agent_runs' and nullif(row_data ->> 'team_id', '') is not null then
    if not exists (
      select 1
        from public.vector_agent_teams
       where id = (row_data ->> 'team_id')::uuid
         and user_id = (row_data ->> 'user_id')::uuid
    ) then
      raise exception 'Agent task ownership mismatch';
    end if;
  elsif tg_table_name = 'vector_agent_messages' then
    if not exists (
      select 1
        from public.vector_agent_runs
       where id = (row_data ->> 'run_id')::uuid
         and user_id = (row_data ->> 'user_id')::uuid
    ) then
      raise exception 'Builder run ownership mismatch';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists vector_agent_runs_owner on public.vector_agent_runs;
create trigger vector_agent_runs_owner
before insert or update of project_id, team_id, user_id on public.vector_agent_runs
for each row execute function public.vector_enforce_agent_ownership();
