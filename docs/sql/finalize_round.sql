-- 1) Защитa от повторных голосов
create unique index if not exists votes_round_voter_uniq on public.votes (round_id, voter_id);

-- 2) Маркер финализации раунда
alter table public.rounds add column if not exists finalized_at timestamptz;

-- 3) Идемпотентная серверная финализация
create or replace function public.finalize_round(p_round_id uuid)
returns table (winner_id uuid, votes_count int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room_id uuid;
  v_phase   text;
  v_final   timestamptz;
begin
  select r.room_id, r.phase, r.finalized_at
    into v_room_id, v_phase, v_final
  from public.rounds r
  where r.id = p_round_id
  for update;

  if v_room_id is null then
    return; -- нет такого раунда
  end if;

  -- если уже финализирован или фаза не voting — выходим (идемпотентно)
  if v_final is not null or v_phase is distinct from 'voting' then
    return;
  end if;

  -- подсчёт голосов по авторам ответов
  with tally as (
    select a.author_id, count(v.id)::int as cnt
    from public.answers a
    left join public.votes v on v.answer_id = a.id
    where a.round_id = p_round_id
    group by a.author_id
  ),
  mx as (select coalesce(max(cnt),0) as m from tally),
  winners as (
    select t.author_id, t.cnt
    from tally t, mx
    where t.cnt = mx.m and mx.m > 0
  )
  update public.room_players rp
     set score = coalesce(rp.score, 0) + 1
    from winners w
   where rp.room_id = v_room_id
     and rp.player_id = w.author_id
  returning w.author_id, w.cnt
  into winner_id, votes_count;

  -- смена фазы и фиксация финализации
  update public.rounds
     set phase = 'results',
         finalized_at = now()
   where id = p_round_id
     and finalized_at is null;

  return;
end
$$;

grant execute on function public.finalize_round(uuid) to authenticated;



