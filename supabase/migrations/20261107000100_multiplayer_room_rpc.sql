-- BibleArena multiplayer room lifecycle and answer validation.
-- Apply this migration to the linked Supabase project before enabling live rooms.
begin;

create table if not exists public.room_answers (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  player_id uuid not null references public.room_players(id) on delete cascade,
  question_id text not null,
  answer_text text not null,
  is_correct boolean not null,
  marks_awarded integer not null default 0 check (marks_awarded in (0, 10)),
  submitted_at timestamptz not null default now(),
  unique (room_id, player_id, question_id)
);

alter table public.room_answers enable row level security;
drop policy if exists "Room members can view room answers" on public.room_answers;
create policy "Room members can view room answers"
  on public.room_answers for select to authenticated
  using (exists (
    select 1 from public.room_players rp
    where rp.room_id = room_answers.room_id and rp.user_id = auth.uid()
  ));
revoke all on public.room_answers from anon, authenticated;
grant select on public.room_answers to authenticated;

create or replace function public.server_now()
returns timestamptz
language sql stable security definer set search_path = public
as $$ select clock_timestamp(); $$;
grant execute on function public.server_now() to anon, authenticated;

create or replace function public.start_game(p_room uuid, p_question_ids text[])
returns public.rooms
language plpgsql security definer set search_path = public
as $$
declare v_room public.rooms; v_count integer;
begin
  select * into v_room from public.rooms where id = p_room for update;
  if not found then raise exception 'Room not found'; end if;
  if v_room.host_id <> auth.uid() then raise exception 'Only the host can start this game'; end if;
  if v_room.status <> 'waiting' then raise exception 'Room is not waiting'; end if;
  if p_question_ids is null or cardinality(p_question_ids) < 1 then raise exception 'Select at least one challenge'; end if;
  if cardinality(p_question_ids) > 50 then raise exception 'A room can contain at most 50 challenges'; end if;
  select count(*) into v_count from public.game_content gc
    where gc.game_slug = v_room.game_id and gc.id = any(p_question_ids);
  if v_count <> cardinality(p_question_ids) then
    raise exception 'Selected game challenges are missing from the published game content. Publish this game content before starting multiplayer.';
  end if;
  update public.rooms set
    status = 'playing',
    question_ids = p_question_ids,
    current_question_index = 0,
    question_started_at = clock_timestamp(),
    question_duration_seconds = greatest(5, least(180, coalesce((settings->>'timeLimit')::integer, question_duration_seconds, 20)))
  where id = p_room returning * into v_room;
  return v_room;
end;
$$;
grant execute on function public.start_game(uuid, text[]) to authenticated;

create or replace function public.submit_room_answer(p_room uuid, p_question_id text, p_answer text)
returns table(is_correct boolean, marks_awarded integer, already_answered boolean)
language plpgsql security definer set search_path = public
as $$
declare v_room public.rooms; v_player public.room_players; v_correct text; v_ok boolean; v_now timestamptz;
begin
  select * into v_room from public.rooms where id = p_room;
  if not found or v_room.status <> 'playing' then raise exception 'This room is not accepting answers'; end if;
  select * into v_player from public.room_players
    where room_id = p_room and user_id = auth.uid();
  if not found then raise exception 'You are not a member of this room'; end if;
  if v_room.current_question_index < 0 or v_room.current_question_index >= cardinality(v_room.question_ids) then
    raise exception 'No active question';
  end if;
  if v_room.question_ids[v_room.current_question_index + 1] <> p_question_id then
    raise exception 'This answer is for a different question';
  end if;
  v_now := clock_timestamp();
  if v_room.question_started_at is null or v_now > v_room.question_started_at + make_interval(secs => v_room.question_duration_seconds) then
    raise exception 'The answer period has ended';
  end if;
  select gc.correct_answer into v_correct from public.game_content gc
    where gc.id = p_question_id and gc.game_slug = v_room.game_id;
  if v_correct is null then raise exception 'Question answer key is unavailable'; end if;
  v_ok := lower(trim(coalesce(p_answer, ''))) = lower(trim(v_correct));
  begin
    insert into public.room_answers(room_id, player_id, question_id, answer_text, is_correct, marks_awarded)
    values (p_room, v_player.id, p_question_id, coalesce(p_answer, ''), v_ok, case when v_ok then 10 else 0 end);
  exception when unique_violation then
    return query select false, 0, true;
    return;
  end;
  if v_ok then
    update public.room_players set score = coalesce(score, 0) + 10 where id = v_player.id;
  end if;
  return query select v_ok, case when v_ok then 10 else 0 end, false;
end;
$$;
grant execute on function public.submit_room_answer(uuid, text, text) to authenticated;

create or replace function public.reveal_current_question(p_room uuid)
returns table(correct_answer text, explanation text, reference text)
language plpgsql security definer set search_path = public
as $$
declare v_room public.rooms; v_id text;
begin
  select * into v_room from public.rooms where id = p_room;
  if not found or v_room.status <> 'playing' then return; end if;
  if v_room.question_started_at is null or clock_timestamp() <
    v_room.question_started_at + make_interval(secs => v_room.question_duration_seconds) then
    raise exception 'The answer is not ready to be revealed';
  end if;
  v_id := v_room.question_ids[v_room.current_question_index + 1];
  return query select gc.correct_answer, gc.explanation, gc.reference
    from public.game_content gc where gc.id = v_id and gc.game_slug = v_room.game_id;
end;
$$;
grant execute on function public.reveal_current_question(uuid) to authenticated;

create or replace function public.advance_question(p_room uuid, p_from_index integer)
returns public.rooms
language plpgsql security definer set search_path = public
as $$
declare v_room public.rooms; v_next integer;
begin
  select * into v_room from public.rooms where id = p_room for update;
  if not found then raise exception 'Room not found'; end if;
  if v_room.status <> 'playing' then return v_room; end if;
  if v_room.current_question_index <> p_from_index then return v_room; end if;
  if v_room.question_started_at is null or clock_timestamp() <
    v_room.question_started_at + make_interval(secs => v_room.question_duration_seconds + v_room.reveal_seconds) then
    return v_room;
  end if;
  v_next := v_room.current_question_index + 1;
  if v_next >= cardinality(v_room.question_ids) then
    update public.rooms set status = 'finished' where id = p_room returning * into v_room;
  else
    update public.rooms set current_question_index = v_next, question_started_at = clock_timestamp()
      where id = p_room returning * into v_room;
  end if;
  return v_room;
end;
$$;
grant execute on function public.advance_question(uuid, integer) to authenticated;

commit;
