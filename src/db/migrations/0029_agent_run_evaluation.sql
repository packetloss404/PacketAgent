-- Persist the bounded first-run evaluation beside the Agent run that produced
-- its evidence. The generic document store already carries this field; the
-- dedicated SQLite read table needs the same JSON payload for parity.

alter table agent_runs
  add column evaluation text
  check (evaluation is null or json_valid(evaluation));
