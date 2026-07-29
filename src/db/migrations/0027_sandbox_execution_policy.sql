alter table sandbox_execs add column wall_clock_timeout_ms integer;
alter table sandbox_execs add column cpu_limit real;
alter table sandbox_execs add column process_limit integer;
alter table sandbox_execs add column tmpfs_size_mb integer;
alter table sandbox_execs add column network_policy text;
alter table sandbox_execs add column filesystem_policy text;
alter table sandbox_execs add column environment_policy text;
