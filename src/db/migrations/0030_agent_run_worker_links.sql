-- Preserve the canonical Worker identity behind each legacy AgentRun
-- compatibility read model. These links are additive so historical Agent
-- runs remain valid, while a partial unique index prevents two compatibility
-- rows from claiming the same canonical WorkerRun.

alter table agent_runs add column worker_definition_id text;
alter table agent_runs add column worker_version_id text;
alter table agent_runs add column worker_deployment_id text;
alter table agent_runs add column worker_run_id text;

create unique index if not exists idx_agent_runs_workspace_worker_run
  on agent_runs (workspace_id, worker_run_id)
  where worker_run_id is not null;
