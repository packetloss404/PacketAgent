create table if not exists users (
  id text primary key,
  email text not null unique,
  display_name text not null,
  timezone text not null,
  password_hash text not null,
  created_at text not null,
  updated_at text not null
);

create table if not exists sessions (
  id text primary key,
  user_id text not null,
  secret_hash text not null,
  created_at text not null,
  last_accessed_at text not null,
  expires_at text not null,
  foreign key (user_id) references users (id) on delete cascade
);

create index if not exists idx_sessions_user on sessions (user_id, expires_at);

create table if not exists workspaces (
  id text primary key,
  slug text not null unique,
  name text not null,
  website text not null,
  automation_goal text not null,
  created_at text not null,
  updated_at text not null
);

create table if not exists workspace_memberships (
  workspace_id text not null,
  user_id text not null,
  role text not null,
  joined_at text not null,
  primary key (workspace_id, user_id),
  foreign key (workspace_id) references workspaces (id) on delete cascade,
  foreign key (user_id) references users (id) on delete cascade,
  check (role in ('owner', 'admin', 'member', 'viewer'))
);

create index if not exists idx_workspace_memberships_user on workspace_memberships (user_id, workspace_id);

create table if not exists workspace_invitations (
  id text primary key,
  workspace_id text not null,
  email text not null,
  role text not null,
  token text not null unique,
  invited_by_user_id text not null,
  accepted_by_user_id text null,
  accepted_at text null,
  revoked_at text null,
  expires_at text not null,
  created_at text not null,
  foreign key (workspace_id) references workspaces (id) on delete cascade,
  foreign key (invited_by_user_id) references users (id) on delete cascade,
  foreign key (accepted_by_user_id) references users (id) on delete set null,
  check (role in ('owner', 'admin', 'member', 'viewer'))
);

create index if not exists idx_workspace_invitations_workspace on workspace_invitations (workspace_id, created_at desc);

create table if not exists workspace_briefs (
  workspace_id text primary key,
  summary text not null,
  goals_json text null,
  audience text null,
  constraints_text text null,
  problem_statement text null,
  target_customers_json text null,
  desired_outcome text null,
  success_metrics_json text null,
  updated_by_user_id text null,
  created_at text not null,
  updated_at text not null,
  foreign key (workspace_id) references workspaces (id) on delete cascade,
  foreign key (updated_by_user_id) references users (id) on delete set null
);

create table if not exists workspace_brief_versions (
  id text primary key,
  workspace_id text not null,
  version_number integer not null,
  summary text not null,
  goals_json text not null,
  audience text not null,
  constraints_text text not null,
  problem_statement text not null,
  target_customers_json text not null,
  desired_outcome text not null,
  success_metrics_json text not null,
  source text not null,
  source_label text null,
  created_by_user_id text null,
  created_by_display_name text null,
  created_at text not null,
  unique (workspace_id, version_number),
  foreign key (workspace_id) references workspaces (id) on delete cascade,
  foreign key (created_by_user_id) references users (id) on delete set null,
  check (source in ('manual', 'template', 'restore'))
);

create index if not exists idx_workspace_brief_versions_workspace on workspace_brief_versions (workspace_id, version_number desc);

create table if not exists requirements (
  id text primary key,
  workspace_id text not null,
  title text not null,
  detail text null,
  description text null,
  priority text not null,
  status text not null,
  acceptance_criteria_json text null,
  source text null,
  created_by_user_id text null,
  created_at text not null,
  updated_at text not null,
  foreign key (workspace_id) references workspaces (id) on delete cascade,
  foreign key (created_by_user_id) references users (id) on delete set null,
  check (priority in ('must', 'should', 'could')),
  check (status in ('draft', 'approved', 'changed', 'done', 'proposed', 'accepted', 'deferred'))
);

create index if not exists idx_requirements_workspace on requirements (workspace_id, status, priority);

create table if not exists implementation_plan_items (
  id text primary key,
  workspace_id text not null,
  requirement_ids_json text not null,
  title text not null,
  description text not null,
  status text not null,
  owner_user_id text null,
  sort_order integer not null,
  started_at text null,
  completed_at text null,
  created_at text not null,
  updated_at text not null,
  foreign key (workspace_id) references workspaces (id) on delete cascade,
  foreign key (owner_user_id) references users (id) on delete set null,
  check (status in ('todo', 'in_progress', 'blocked', 'done'))
);

create index if not exists idx_implementation_plan_items_workspace on implementation_plan_items (workspace_id, sort_order);

create table if not exists workflow_concerns (
  id text primary key,
  workspace_id text not null,
  kind text not null,
  title text not null,
  description text not null,
  status text not null,
  severity text not null,
  related_plan_item_id text null,
  related_requirement_id text null,
  owner_user_id text null,
  resolved_at text null,
  resolution_note text null,
  created_at text not null,
  updated_at text not null,
  foreign key (workspace_id) references workspaces (id) on delete cascade,
  foreign key (related_plan_item_id) references implementation_plan_items (id) on delete set null,
  foreign key (related_requirement_id) references requirements (id) on delete set null,
  foreign key (owner_user_id) references users (id) on delete set null,
  check (kind in ('blocker', 'open_question')),
  check (status in ('open', 'resolved', 'deferred')),
  check (severity in ('low', 'medium', 'high', 'critical'))
);

create index if not exists idx_workflow_concerns_workspace on workflow_concerns (workspace_id, status, severity);

create table if not exists validation_evidence (
  id text primary key,
  workspace_id text not null,
  plan_item_id text null,
  requirement_ids_json text null,
  type text null,
  title text not null,
  detail text null,
  description text null,
  status text null,
  outcome text null,
  source text null,
  evidence_url text null,
  captured_by_user_id text null,
  captured_at text null,
  created_at text not null,
  updated_at text not null,
  foreign key (workspace_id) references workspaces (id) on delete cascade,
  foreign key (plan_item_id) references implementation_plan_items (id) on delete set null,
  foreign key (captured_by_user_id) references users (id) on delete set null,
  check (status is null or status in ('pending', 'passed', 'failed'))
);

create index if not exists idx_validation_evidence_workspace on validation_evidence (workspace_id, status, captured_at desc);

create table if not exists release_confirmations (
  workspace_id text primary key,
  id text null unique,
  confirmed integer null,
  summary text null,
  confirmed_by text null,
  version_label text null,
  status text null,
  confirmed_by_user_id text null,
  confirmed_at text null,
  release_notes text null,
  validation_evidence_ids_json text null,
  created_at text null,
  updated_at text not null,
  foreign key (workspace_id) references workspaces (id) on delete cascade,
  foreign key (confirmed_by_user_id) references users (id) on delete set null,
  check (confirmed is null or confirmed in (0, 1)),
  check (status is null or status in ('pending', 'confirmed', 'rolled_back'))
);

create table if not exists onboarding_states (
  workspace_id text primary key,
  status text not null,
  current_step text not null,
  completed_steps_json text not null,
  completed_at text null,
  updated_at text not null,
  foreign key (workspace_id) references workspaces (id) on delete cascade,
  check (status in ('not_started', 'in_progress', 'completed')),
  check (current_step in ('create_workspace_profile', 'define_requirements', 'define_plan', 'start_implementation', 'validate', 'confirm_release'))
);

create table if not exists activities (
  id text primary key,
  workspace_id text not null,
  scope text not null,
  event text not null,
  actor_json text not null,
  data_json text not null,
  occurred_at text not null,
  foreign key (workspace_id) references workspaces (id) on delete cascade,
  check (scope in ('account', 'workspace', 'activation'))
);

create index if not exists idx_activities_workspace on activities (workspace_id, occurred_at desc);

create table if not exists providers (
  id text primary key,
  workspace_id text not null,
  name text not null,
  kind text not null,
  default_model text not null,
  base_url text null,
  api_key_configured integer not null,
  status text not null,
  created_at text not null,
  updated_at text not null,
  foreign key (workspace_id) references workspaces (id) on delete cascade,
  check (kind in ('openai', 'anthropic', 'minimax', 'azure_openai', 'ollama', 'gemini', 'openrouter', 'custom')),
  check (api_key_configured in (0, 1)),
  check (status in ('connected', 'missing_key', 'disabled'))
);

create index if not exists idx_providers_workspace on providers (workspace_id, kind, status);

create table if not exists agents (
  id text primary key,
  workspace_id text not null,
  name text not null,
  description text not null,
  instructions text not null,
  provider_id text null,
  model text null,
  tools_json text not null,
  enabled_tools_json text null,
  route_key text null,
  webhook_token text null unique,
  schedule text null,
  trigger_kind text null,
  playbook_json text null,
  status text not null,
  created_by_user_id text not null,
  template_id text null,
  input_schema_json text not null,
  created_at text not null,
  updated_at text not null,
  archived_at text null,
  foreign key (workspace_id) references workspaces (id) on delete cascade,
  foreign key (provider_id) references providers (id) on delete set null,
  foreign key (created_by_user_id) references users (id) on delete cascade,
  check (status in ('active', 'paused', 'archived')),
  check (trigger_kind is null or trigger_kind in ('manual', 'schedule', 'webhook', 'email'))
);

create index if not exists idx_agents_workspace on agents (workspace_id, status);
create index if not exists idx_agents_route_key on agents (route_key);

create table if not exists agent_runs (
  id text primary key,
  workspace_id text not null,
  agent_id text null,
  title text not null,
  status text not null,
  trigger_kind text null,
  transcript_json text null,
  started_at text null,
  completed_at text null,
  inputs_json text null,
  output text null,
  error text null,
  logs_json text not null,
  tool_calls_json text null,
  model_used text null,
  cost_usd real null,
  created_at text not null,
  updated_at text not null,
  foreign key (workspace_id) references workspaces (id) on delete cascade,
  foreign key (agent_id) references agents (id) on delete set null,
  check (status in ('queued', 'running', 'success', 'failed', 'canceled')),
  check (trigger_kind is null or trigger_kind in ('manual', 'schedule', 'webhook', 'email'))
);

create index if not exists idx_agent_runs_workspace on agent_runs (workspace_id, created_at desc);
create index if not exists idx_agent_runs_agent on agent_runs (agent_id, created_at desc);

create table if not exists workspace_env_vars (
  id text primary key,
  workspace_id text not null,
  key text not null,
  value text not null,
  scope text not null,
  secret integer not null,
  description text null,
  created_by_user_id text null,
  created_at text not null,
  updated_at text not null,
  unique (workspace_id, key),
  foreign key (workspace_id) references workspaces (id) on delete cascade,
  foreign key (created_by_user_id) references users (id) on delete set null,
  check (scope in ('all', 'build', 'runtime')),
  check (secret in (0, 1))
);

create table if not exists api_keys (
  id text primary key,
  workspace_id text not null,
  provider text not null,
  label text not null,
  encrypted_value text not null,
  iv text not null,
  auth_tag text not null,
  last_used_at text null,
  created_at text not null,
  updated_at text not null,
  foreign key (workspace_id) references workspaces (id) on delete cascade,
  check (provider in ('anthropic', 'openai', 'openrouter', 'minimax', 'ollama', 'gemini'))
);

create index if not exists idx_api_keys_workspace on api_keys (workspace_id, provider);

create table if not exists provider_calls (
  id text primary key,
  workspace_id text not null,
  route_key text not null,
  provider text not null,
  model text not null,
  prompt_tokens integer not null,
  completion_tokens integer not null,
  cost_usd real not null,
  duration_ms integer not null,
  status text not null,
  error_message text null,
  started_at text not null,
  completed_at text not null,
  foreign key (workspace_id) references workspaces (id) on delete cascade,
  check (provider in ('anthropic', 'openai', 'openrouter', 'minimax', 'ollama', 'gemini', 'stub')),
  check (status in ('success', 'error', 'canceled'))
);

create index if not exists idx_provider_calls_workspace on provider_calls (workspace_id, started_at desc);

create table if not exists jobs (
  id text primary key,
  workspace_id text not null,
  type text not null,
  payload_json text not null,
  status text not null,
  attempts integer not null,
  max_attempts integer not null,
  scheduled_at text not null,
  started_at text null,
  completed_at text null,
  cron text null,
  result_json text null,
  error text null,
  cancel_requested integer null,
  created_at text not null,
  updated_at text not null,
  foreign key (workspace_id) references workspaces (id) on delete cascade,
  check (status in ('queued', 'running', 'success', 'failed', 'canceled')),
  check (cancel_requested is null or cancel_requested in (0, 1))
);

create index if not exists idx_jobs_status on jobs (status, scheduled_at);
create index if not exists idx_jobs_workspace on jobs (workspace_id, created_at desc);

create table if not exists share_tokens (
  id text primary key,
  workspace_id text not null,
  token text not null unique,
  scope text not null,
  created_by_user_id text not null,
  expires_at text null,
  revoked_at text null,
  last_read_at text null,
  read_count integer not null default 0,
  created_at text not null,
  foreign key (workspace_id) references workspaces (id) on delete cascade,
  foreign key (created_by_user_id) references users (id) on delete cascade,
  check (scope in ('brief', 'plan', 'overview'))
);

create index if not exists idx_share_tokens_workspace on share_tokens (workspace_id, scope, created_at desc);

create table if not exists activation_facts (
  workspace_id text primary key,
  facts_json text not null,
  updated_at text not null default (datetime('now')),
  foreign key (workspace_id) references workspaces (id) on delete cascade
);

create table if not exists activation_read_models (
  workspace_id text primary key,
  status_json text not null,
  updated_at text not null default (datetime('now')),
  foreign key (workspace_id) references workspaces (id) on delete cascade
);
