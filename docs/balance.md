# Pixel Clash balance (M6, M8.5 walls and factories, M8.6 minion kinds, M8.7 routing, M8.8 elements and support)

Plan §14 `balance.test.ts`, §6 ("no single archetype dominates"), §9 sudden death.
Test: `tests/balance.test.ts` (harness `tests/helpers/balance.ts`). Regenerate every
number below with:

```
npx tsx --conditions=source scripts/balance-matrix.ts
```

For quick checks and config experiments use `npm run balance` (early stopping and a
result cache; see [Fast balance runs](#fast-balance-runs-tooling-2026-10-24) at the end).

**M8.8:** every archetype was refit to the ×5 economy and the matrix grew to 37 archetypes;
the current numbers are in [Elements, splash, support and the ×5 economy (M8.8)](#elements-splash-support-and-the-5-economy-m88)
at the end. The sections before it are the $1,000-game history (the sim is
scale-invariant, so their shapes carried over until the M8.8 refit).

Bots use the template logic: soldiers chase the nearest enemy (a seeded PRNG breaks
near-ties, so seeds differ a little), towers shoot the nearest enemy in range. Every
army is placed front cells first. All battles use the **default config** (5400 ticks,
§6 costs unchanged). Since M8.5 the bots follow the wall-aware templates: soldiers and
towers skip walls as targets (a wall only when nothing else is left / in range), a
soldier smashes an enemy wall that has blocked it for 120 ticks, factories rally their
minions on the nearest enemy that isn't a wall, and minions run the engine's built-in AI.
The M8.5 results are in [Walls and factories (M8.5)](#walls-and-factories-m85) below.

## What changed: sudden death

| | start | radius (800 arena) | damage outside |
|---|---|---|---|
| before M6 | tick 3600 (60 s) | 570 → 60 | 4% max HP/s |
| **M6 default** | **tick 3000 (50 s)** | 570 → 60 (unchanged) | **7% max HP/s** |

Why: with 60 s / 4%/s, two all-tower armies on **Duel, Corners 4 and Ring 8** (where
towers can never reach each other) both took sudden-death damage but reached 90 s
without losing a single tower, so the match was a pure timeout tie (or decided by
living cost: the turtle that sat still won). A sweep over start tick, end radius and
damage (`start ∈ {2400, 2700, 3000, 3600}`, `end radius ∈ {0, 30, 60}`, `damage ∈
{4…8}%/s`) found 50 s / 7%/s to be the mildest setting that kills towers in every
all-tower battle on every map style, while keeping the end radius (so the §9.2 scaled
radii 570/741/855 → 60/78/90 are unchanged). Costs, bounds and coefficients were not
changed, so the §6 tables still hold.

Side effect, by design: at 7%/s a unit dies about 14.3 s after the circle reaches it, so
units that stay more than about 255 px from the centre (800 arena; scaled with the arena)
die before 90 s, and anything closer survives. Two mirrored tower armies in far zones
therefore often die on the same tick and share a place (instead of tying alive), while
towers near the centre (Triangle, a Lanes centre lane) can still reach the timeout. `sim.test.ts` "two template armies
face off" was adjusted for this (its smaller army now keeps only its back-corner tower).

Updated with it: `config/default.json`, `DEFAULT_CONFIG`, plan §5 (contract comment), §9,
§9.2, §11 (CLAUDE.md summary), the kit's `CLAUDE.md.tmpl` and `PROMPTS.md`, the
`get_unit_contract` strategy tip, the /screen fallback, `geometry.test.ts`, `maps.test.ts`.

## Archetypes ($1,000 budget each)

| key | army | cost |
|---|---|---|
| bricks | 2 × Brick (soldier 430 HP, 50 dmg, range 40, speed 1.5, size 16) at $496 | $992 |
| templates | 4 Basic Soldiers + 3 Basic Towers | $962 |
| tanks | Big Tank army: 5 × §6 Half Tank (250 HP, 20 dmg, speed 0.8, size 20) at $180 | $900 |
| turtle | all-tower turtle: 5 Basic Towers | $990 |
| scouts | scout swarm: 11 × Scout (60 HP, 8 dmg, range 20, speed 2.5, size 6) at $87 | $957 |
| snipers | sniper nest: 3 × §6 Sniper Tower (80 HP, 40 dmg, range 280) at $305 | $915 |
| rush | soldier rush: 10 Basic Soldiers | $920 |

(Five full 500-HP Big Tanks cost $2,310, so the "Big Tank army" uses the §6 Half Tank.)

## Round robin

(Since M8.5 these 6×6 numbers are the first six rows and columns of the 13-archetype
matrix below; each pair's battles don't depend on who else is in the matrix, so they are
unchanged, and so are the `DOMINANCE_EXCEPTIONS` asserted on them.)

Corners 4 (zones TL-TR and TL-BR) and Ring 8 (zones 0-1 edge-corner and 0-2 edge-edge),
both orders, seeds 11 and 4242: 16 battles per pair. Row archetype's wins-draws-losses
against the column; **bold** = winning record.

| vs | bricks | templates | tanks | turtle | scouts | snipers | beats |
|---|---|---|---|---|---|---|---|
| bricks | · | **16-0-0** | 7-0-9 | **16-0-0** | **16-0-0** | **16-0-0** | 4/5 |
| templates | 0-0-16 | · | 0-0-16 | 2-0-14 | **16-0-0** | 2-0-14 | 1/5 |
| tanks | **9-0-7** | **16-0-0** | · | 8-0-8 | **16-0-0** | **14-0-2** | 4/5 |
| turtle | 0-0-16 | **14-0-2** | 8-0-8 | · | **16-0-0** | 2-12-2 | 2/5 |
| scouts | 0-0-16 | 0-0-16 | 0-0-16 | 0-0-16 | · | **16-0-0** | 1/5 |
| snipers | 0-0-16 | **14-0-2** | 2-0-14 | 2-12-2 | 0-0-16 | · | 1/5 |

Asserted: no archetype beats every other one, every archetype beats at least one, and
(§6 "no single archetype dominates") every archetype has a losing matchup and wins at most
70% of its 80 round-robin battles. Two archetypes miss that today and are **explicit,
capped exceptions** in `tests/balance.test.ts` (`DOMINANCE_EXCEPTIONS`), so they can only
get better, never silently worse: bricks win 71 of 80 (89%, cap 0.89), and the tanks win
63 of 80 (79%, cap 0.79) with no losing matchup.
The top is a loop: tanks edge bricks (9-7), bricks crush the turtle, the turtle holds
the tanks to 8-8. **Watch item:** tanks and bricks are clearly the strongest pair and
the tanks are unbeaten (their worst is the 8-8 with the turtle). The margin is thin; if
real players converge on Half-Tank spam, raise `cost.hp` or `curveK` a little (and update
the §6 tables and `cost.test.ts`). The scout swarm only beats the sniper nest: with
range 20 and 8 damage it melts against anything that hits back.

## All-tower armies (sudden death bites)

Every map style at its largest arena. "zones 0, n/2" = two armies; "all" = every zone
filled, alternating the two armies. Asserted: every army still standing is caught by
the circle before 90 s, and towers die in every battle.

| map | armies | zones | first hit | circle reaches | towers lost | end | places |
|---|---|---|---|---|---|---|---|
| duel 2 | turtle / turtle | all | - | 69.9 s | 5, 5 | 89.0 s elimination | 1, 1 |
| duel 2 | snipers / turtle | all | - | 69.9 s | 3, 5 | 89.0 s elimination | 1, 1 |
| duel 2 | snipers / snipers | all | - | 72.4 s | 3, 3 | 89.0 s elimination | 1, 1 |
| triangle 3 | turtle / turtle | 0, 1 | - | 74.3 s | 0, 1 | 90.0 s timeout | 1, 2 |
| triangle 3 | turtle / turtle | all | - | 74.3 s | 0, 1, 1 | 90.0 s timeout | 1, 2, 2 |
| triangle 3 | snipers / turtle | 0, 1 | 0.4 s | 74.3 s | 0, 3 | 90.0 s timeout | 1, 2 |
| triangle 3 | snipers / turtle | all | 0.4 s | 79.2 s | 1, 5, 2 | 90.0 s timeout | 1, 3, 2 |
| triangle 3 | snipers / snipers | 0, 1 | 0.4 s | 79.2 s | 1, 1 | 90.0 s timeout | 1, 1 |
| triangle 3 | snipers / snipers | all | 0.4 s | - | 1, 3, 3 | 1.4 s elimination | 1, 2, 2 |
| corners 4 | turtle / turtle | 0, 2 | - | 69.9 s | 5, 5 | 89.0 s elimination | 1, 1 |
| corners 4 | turtle / turtle | all | - | 69.9 s | 5, 5, 5, 5 | 89.0 s elimination | 1, 1, 1, 1 |
| corners 4 | snipers / turtle | 0, 2 | - | 69.9 s | 3, 5 | 89.0 s elimination | 1, 1 |
| corners 4 | snipers / turtle | all | - | 69.9 s | 3, 5, 3, 5 | 89.0 s elimination | 1, 1, 1, 1 |
| corners 4 | snipers / snipers | 0, 2 | - | 72.4 s | 3, 3 | 89.0 s elimination | 1, 1 |
| corners 4 | snipers / snipers | all | - | 72.4 s | 3, 3, 3, 3 | 89.0 s elimination | 1, 1, 1, 1 |
| ring 8 | turtle / turtle | 0, 4 | - | 74.2 s | 5, 5 | 89.1 s elimination | 1, 1 |
| ring 8 | turtle / turtle | all | - | 63.5 s | 5 each | 89.1 s elimination | 1, 5, 1, 5, 1, 5, 1, 5 |
| ring 8 | snipers / turtle | 0, 4 | - | 74.2 s | 3, 5 | 89.1 s elimination | 1, 1 |
| ring 8 | snipers / turtle | all | - | 63.5 s | 3, 5, 3, 5, … | 89.1 s elimination | 1, 5, 1, 5, 1, 5, 1, 5 |
| ring 8 | snipers / snipers | 0, 4 | - | 74.6 s | 3, 3 | 89.1 s elimination | 1, 1 |
| ring 8 | snipers / snipers | all | - | 65.1 s | 3 each | 89.1 s elimination | 1, 5, 1, 5, 1, 5, 1, 5 |
| lanes 8 | turtle / turtle | 0, 4 | - | 65.0 s | 5, 5 | 87.0 s elimination | 1, 1 |
| lanes 8 | turtle / turtle | all | 0.2 s | 65.0 s | 5, 3, 3, 5, 5, 3, 3, 5 | 90.0 s timeout | 5, 1, 1, 5, 5, 1, 1, 5 |
| lanes 8 | snipers / turtle | 0, 4 | - | 65.0 s | 3, 5 | 87.0 s elimination | 1, 1 |
| lanes 8 | snipers / turtle | all | 0.2 s | 65.0 s | 3, 5, 1, 5, 3, 5, 1, 5 | 90.0 s timeout | 3, 7, 1, 5, 3, 7, 1, 5 |
| lanes 8 | snipers / snipers | 0, 4 | - | 68.9 s | 3, 3 | 87.0 s elimination | 1, 1 |
| lanes 8 | snipers / snipers | all | 0.2 s | 68.9 s | 3 each | 87.0 s elimination | 1, 5, 5, 1, 1, 5, 5, 1 |
| islands 8 | turtle / turtle | 0, 4 | - | 63.5 s | 5, 5 | 80.9 s elimination | 1, 1 |
| islands 8 | turtle / turtle | all | 0.3 s | 63.5 s | 5 each | 88.9 s elimination | 5, 1, 5, 1, 5, 1, 5, 1 |
| islands 8 | snipers / turtle | 0, 4 | - | 63.5 s | 3, 5 | 80.9 s elimination | 1, 1 |
| islands 8 | snipers / turtle | all | 0.3 s | 65.1 s | 3, 5, 3, 5, … | 88.9 s elimination | 5, 1, 5, 1, 5, 1, 5, 1 |
| islands 8 | snipers / snipers | 0, 4 | - | 65.1 s | 3, 3 | 80.9 s elimination | 1, 1 |
| islands 8 | snipers / snipers | all | 0.4 s | 65.1 s | 3 each | 88.9 s elimination | 5, 1, 5, 1, 5, 1, 5, 1 |

Before the retune the Duel, Corners 4 and Ring 8 rows all read "towers lost 0 … 90.0 s
timeout, all tied". Triangle zone 0's front row sits 180 px from the centre, so its
front towers outlast the circle (by design: the closest zone in that layout); rotation
gives every player that zone once.

## Tower turtle vs soldier rush: the rush wins

Stated expected outcome (asserted: the rush wins ≥ 3 of 4 duels, and the rush team
wins every Lanes case). Measured: the rush wins **14 of 16** duels and **4 of 4** Lanes
battles, all by elimination at 14-23 s, long before sudden death.

- Corners 4, every zone pair, order and seed: rush (8/8).
- Ring 8 zones 0/2: rush (4/4). Ring 8 zones 0/1: the rush wins from the corner zone,
  but the turtle wins 2/2 when it holds the corner zone 1 (the edge-zone rush arrives
  strung out). That's geometry, and rotation evens it out.
- Lanes 4 (2v2) and Lanes 8 (4v4), both block rotations: the rush team.

## Mixed 2-team Lanes 8 (4v4)

bricks + templates + tanks + turtle vs scouts + snipers + rush + templates: first hit at
1.1-1.4 s, decided both rotations (team 1 at the 90 s timeout in round 0, team 0 by
elimination at 28 s in round 1). Asserted: contact before sudden death and a winner.

## Ring 8 free-for-all, 8 rotations × 2 seeds

All six archetypes + rush + templates, rotated through every zone.

- 1st places by zone index 0-7: 4, 2, 2, 2, 4, 2, 4, 2. Asserted: max ≤ 2× the mean, no
  zone without a win. No zone is favoured.
- 1st places by army: **turtle 14**, snipers 8 (some battles end with a shared 1st).
  Asserted: no army takes more than half the 1st places, except the turtle, an explicit
  exception capped at today's 14 of 16 (`DOMINANCE_EXCEPTIONS` in `tests/balance.test.ts`).

**Watch item:** in a big free-for-all the chase-nearest soldier armies grind each other
down and the turtle, which never walks into anyone, mops up the remnants (it wins alone by
elimination at 32-38 s, or shares 1st with the sniper nest when sudden death ends the
battle at 89 s). Smarter player units
(focus fire, retreating into the circle) and the damage/value bonuses (§9 Points) offset
this in real play, so no retune was made for it (it is a capped exception in the test instead). If it shows up on the day, the lever is
tower cost (raise `cost.range`, which mostly prices towers) rather than more sudden death,
because the turtle wins most of these long before 50 s.

## Walls and factories (M8.5)

Plan §5.2 / §6: walls (40×40 blocks, 50-1500 HP, no attack, no code) and factories
(radius 18, 100-1000 HP, built-in 40 HP / 5 damage minions every 600-1800 ticks).
Same harness, same default config, same sites and seeds as the round robin above.

**Walls allowed (2026-10-25, plan §9.1b).** The host can switch walls off for a match.
The balance tooling is unchanged: it runs with walls (the default). A
`wallsAllowed: false` match simply excludes the archetypes that field walls; the
battles between the others are the same battles.

### Building archetypes ($1,000 budget each)

| key | army | cost |
|---|---|---|
| fortress | **sealed** wall fortress: 11 Basic Walls closing the zone off (diagonal zones: row 0 + col 0, the other two sides are the arena edge; N/S/E/W zones, since M8.7: a pocket of rows 3-5 × cols 1-4 against the back edge, or a 7-wall ring round an L of 3 cells where the back isn't the edge), 3 Basic Towers inside | $946 |
| snipewall | walled sniper nest: 6 Basic Walls, 2 Sniper Towers + 1 Basic Tower (since M8.7 the walls close the towers into the zone's back corner / back edge; Lanes: front cells as before) | $1000 |
| swarm | factory swarm (plan §6): 4 Basic Soldiers in front, 2 Swarm Factories (300 HP, interval 600: 8 minions each) behind | $922 |
| wallrush | walls + rush: 4 Basic Walls in the front cells, 9 Basic Soldiers behind them | $956 |
| mixed | plan §6 mixed: 4 Basic Soldiers, then 6 Basic Walls, then 2 Basic Towers | $956 |
| quad | all four templates: 5 Basic Soldiers, 4 Basic Walls, 1 Basic Tower, 1 Basic Factory | $979 |
| bunker | all-building bunker: 2 Basic Towers in front of 2 Swarm Factories (no soldier, no wall) | $950 |
| openfort | plan §14 open fortress (not in the round robin): 10 Basic Walls in a U (front row + both outer columns of rows 1-2), 3 Basic Towers on rows 3-4 | $914 |

Reference prices (unchanged, §6): Basic Wall $32, Basic Factory $193, Swarm Factory $277,
minion $55 → $28 per minion paid up front.

### Round robin, 13 archetypes

16 battles per pair (Corners 4 TL-TR and TL-BR, Ring 8 zones 0-1 and 0-2, both orders,
seeds 11 and 4242). Row archetype's wins-draws-losses against the column; **bold** =
winning record.

| vs | bricks | templates | tanks | turtle | scouts | snipers | fortress | snipewall | swarm | wallrush | mixed | quad | bunker | beats |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| bricks | · | **16-0-0** | 7-0-9 | **16-0-0** | **16-0-0** | **16-0-0** | 2-0-14 | 8-0-8 | **16-0-0** | **11-0-5** | **16-0-0** | **16-0-0** | **16-0-0** | 9/12 |
| templates | 0-0-16 | · | 0-0-16 | 2-0-14 | **16-0-0** | 2-0-14 | 6-0-10 | **14-0-2** | 2-0-14 | 0-0-16 | **14-0-2** | 2-0-14 | 0-0-16 | 3/12 |
| tanks | **9-0-7** | **16-0-0** | · | 8-0-8 | **16-0-0** | **14-0-2** | 0-0-16 | 2-0-14 | **16-0-0** | **16-0-0** | **14-0-2** | **16-0-0** | **16-0-0** | 9/12 |
| turtle | 0-0-16 | **14-0-2** | 8-0-8 | · | **16-0-0** | 2-12-2 | **14-0-2** | **14-0-2** | 2-0-14 | **16-0-0** | **14-0-2** | 2-0-14 | 0-0-16 | 6/12 |
| scouts | 0-0-16 | 0-0-16 | 0-0-16 | 0-0-16 | · | **16-0-0** | 0-0-16 | 4-0-12 | **16-0-0** | 0-0-16 | 0-0-16 | **9-0-7** | **10-0-6** | 4/12 |
| snipers | 0-0-16 | **14-0-2** | 2-0-14 | 2-12-2 | 0-0-16 | · | **14-0-2** | **14-0-2** | **10-0-6** | 4-0-12 | **14-0-2** | 6-0-10 | 2-4-10 | 5/12 |
| fortress | **14-0-2** | **10-0-6** | **16-0-0** | 2-0-14 | **16-0-0** | 2-0-14 | · | **10-4-2** | 2-0-14 | **14-0-2** | **14-0-2** | 2-0-14 | 2-0-14 | 7/12 |
| snipewall | 8-0-8 | 2-0-14 | **14-0-2** | 2-0-14 | **12-0-4** | 2-0-14 | 2-4-10 | · | 2-0-14 | **14-0-2** | **14-0-2** | 2-0-14 | 2-0-14 | 4/12 |
| swarm | 0-0-16 | **14-0-2** | 0-0-16 | **14-0-2** | 0-0-16 | 6-0-10 | **14-0-2** | **14-0-2** | · | 0-0-16 | **14-0-2** | 0-0-16 | **9-0-7** | 6/12 |
| wallrush | 5-0-11 | **16-0-0** | 0-0-16 | 0-0-16 | **16-0-0** | **12-0-4** | 2-0-14 | 2-0-14 | **16-0-0** | · | **13-0-3** | **16-0-0** | **14-0-2** | 7/12 |
| mixed | 0-0-16 | 2-0-14 | 2-0-14 | 2-0-14 | **16-0-0** | 2-0-14 | 2-0-14 | 2-0-14 | 2-0-14 | 3-0-13 | · | 2-0-14 | 1-0-15 | 1/12 |
| quad | 0-0-16 | **14-0-2** | 0-0-16 | **14-0-2** | 7-0-9 | **10-0-6** | **14-0-2** | **14-0-2** | **16-0-0** | 0-0-16 | **14-0-2** | · | 2-0-14 | 7/12 |
| bunker | 0-0-16 | **16-0-0** | 0-0-16 | **16-0-0** | 6-0-10 | **10-4-2** | **14-0-2** | **14-0-2** | 7-0-9 | 2-0-14 | **15-0-1** | **14-0-2** | · | 7/12 |

| archetype | wins vs the six | wins vs all 12 |
|---|---|---|
| bricks | 71/80 (89%) | 156/192 (81%) |
| templates | 20/80 (25%) | 58/192 (30%) |
| tanks | 63/80 (79%) | 143/192 (74%) |
| turtle | 40/80 (50%) | 102/192 (53%) |
| scouts | 16/80 (20%) | 55/192 (29%) |
| snipers | 18/80 (23%) | 82/192 (43%) |
| fortress | - | 104/192 (54%) |
| snipewall | - | 76/192 (40%) |
| swarm | - | 85/192 (44%) |
| wallrush | - | 112/192 (58%) |
| mixed | - | 36/192 (19%) |
| quad | - | 105/192 (55%) |
| bunker | - | 114/192 (59%) |

Asserted on the full matrix (`tests/balance.test.ts`): nobody beats every other archetype,
everyone beats at least one and loses to at least one (the tanks are no longer unbeaten:
the sealed fortress and the walled sniper nest beat them), nobody wins more than 70% of
its 192 battles, and **no battle is won by a side with only walls left**. Every building
archetype fits the general caps with **no exceptions**: fortress 54%, snipewall 40%,
swarm 44%, wallrush 58%, mixed 19%, quad 55%, bunker 59%. The two old exceptions are
capped again at today's full-matrix numbers (`FULL_DOMINANCE_EXCEPTIONS`): bricks 156 of
192 (81%, down from 89% among the six; they lose to the tanks, the sealed fortress and
walls + rush), tanks 143 of 192 (74%).

The shape (asserted where marked):

- **Walls stop melee.** The sealed fortress beats the tanks 16-0, the bricks 14-2 and the
  scouts 16-0 (asserted) and holds the rush (below): chase-nearest soldiers wait 2 s at
  the wall, then each hits the wall that blocked *it*, so 10 soldiers spread over 11 walls
  while 3 towers shoot them. Focus fire on one wall is the counterplay (players' code, not
  the template).
- **Range and minions break walls.** The fortress loses to the turtle, the sniper nest,
  the factory swarm and the bunker (asserted): projectiles fly over walls, and on Corners
  the sealed towers sit one cell deeper than a turtle's, so the sudden-death circle
  reaches them first. Walls never help in a pure tower-vs-tower race.
- **Factories** beat the tower armies (swarm vs turtle 14-2, asserted; bunker vs turtle
  16-0) and the fortress, and lose to big melee bodies: 40 HP / 5 damage minions barely
  scratch a 250 HP Half Tank or a 430 HP brick (tanks beat the swarm 16-0, asserted).
  Swarm vs bunker (both on 2 Swarm Factories) is a close matchup: 9-7 to the swarm
  (asserted: neither side wins more than 10 of 16). It was 7-9 before the minion AI fixes
  (smash a wall in the way while chasing, sidestep towers and factories) and `canMake`.
- **A factory that never builds can't turtle.** A factory is a fighter, and its unbuilt
  minions count toward its living value, only while it can still build them before time
  runs out (`canMake`, plan §9.3); at the time limit it is worth its body alone. 4 Basic
  Walls + 2 *holding* Fortress Factories (1000 HP, interval 1800; $980, no damage) lose
  all 32 duels against the walled sniper nest and the sealed fortress and are out by
  60 s at the latest (asserted). Before this rule they beat the sniper nest 14 of 16.
- **Partial walls are a weak buy.** mixed (19%) and the open U fortress lose to almost
  everything; wallrush (walls in front of soldiers) beats the templates (asserted) but
  loses to the plain rush. Walls placed in front of fighters push the fighters one band
  deeper into the zone, where sudden death reaches them first, and enemies slide round an
  unclosed line. Even free walls don't help: 4 soldiers + 6 walls + **3** towers (the
  templates plus 6 walls) still lose to the templates 2-14. So the cost of a partial wall
  is geometry, not price (see tuning below).

### Fortress vs rush

| fortress | rush wins | ends |
|---|---|---|
| open U (plan §14) | **16 of 16** | 8.5-25.1 s, elimination |
| sealed (11 walls) | **0 of 16** | 21.1-24.1 s, elimination |

Asserted: the rush beats the plan's open fortress in ≥ 3 of 4 duels (the stated outcome
of plan §14), and the sealed fortress holds the rush (≤ 1 in 4); both are decided by
fighting before sudden death. The sealed box is the strong fortress; its answers are
range, factories and sudden death (matrix above).

### All-building armies: no turtle wins

Every map style at its largest arena, as for the all-tower table. "lost (placed)" counts
placed bodies (walls included, minions not); "standing" is what is left at the end.

| map | armies | zones | first hit | lost (placed) | standing | end | places |
|---|---|---|---|---|---|---|---|
| duel 2 | fortress / fortress | all | - | 14, 14 | none; none | 84.6 s elimination | 1, 1 |
| duel 2 | bunker / fortress | all | 14.4 s | 1, 14 | 2 tower + 1 factory + 6 minion; none | 84.6 s elimination | 1, 2 |
| duel 2 | snipewall / bunker | all | 13.7 s | 9, 0 | none; 2 tower + 2 factory + 6 minion | 82.3 s elimination | 2, 1 |
| triangle 3 | fortress / fortress | 0, 1 | - | 3, 6 | 8 wall + 3 tower; 6 wall + 2 tower | 90.0 s timeout | 1, 2 |
| triangle 3 | fortress / fortress | all | - | 3, 6, 6 | 8 wall + 3 tower; 6 wall + 2 tower; 6 wall + 2 tower | 90.0 s timeout | 1, 2, 2 |
| triangle 3 | bunker / fortress | 0, 1 | 11.1 s | 0, 6 | 2 factory + 2 minion + 2 tower; 6 wall + 2 tower | 90.0 s timeout | 1, 2 |
| triangle 3 | bunker / fortress | all | 10.6 s | 0, 6, 0 | 2 factory + 2 tower; 6 wall + 2 tower; 2 tower + 2 factory | 90.0 s timeout | 1, 3, 1 |
| triangle 3 | snipewall / bunker | 0, 1 | 0.5 s | 0, 1 | 6 wall + 3 tower; 1 tower + 2 factory | 90.0 s timeout | 1, 2 |
| triangle 3 | snipewall / bunker | all | 0.5 s | 5, 1, 3 | 2 wall + 2 tower; 1 tower + 2 factory; 3 wall + 3 tower | 90.0 s timeout | 2, 3, 1 |
| corners 4 | fortress / fortress | 0, 2 | - | 14, 14 | none; none | 84.6 s elimination | 1, 1 |
| corners 4 | fortress / fortress | all | - | 14, 14, 14, 14 | none; none; none; none | 84.6 s elimination | 1, 1, 1, 1 |
| corners 4 | bunker / fortress | 0, 2 | 14.4 s | 1, 14 | 2 tower + 1 factory + 6 minion; none | 84.6 s elimination | 1, 2 |
| corners 4 | bunker / fortress | all | 12.2 s | 4, 14, 4, 14 | 1 minion; none; 1 minion; none | 90.0 s timeout | 1, 3, 1, 3 |
| corners 4 | snipewall / bunker | 0, 2 | 13.7 s | 9, 0 | none; 2 tower + 2 factory + 6 minion | 82.3 s elimination | 2, 1 |
| corners 4 | snipewall / bunker | all | 11.2 s | 9, 4, 9, 4 | none; 1 minion; none; 1 minion | 90.0 s timeout | 3, 1, 3, 1 |
| ring 8 | fortress / fortress | 0, 4 | - | 14, 14 | none; none | 87.0 s elimination | 1, 1 |
| ring 8 | fortress / fortress | all | - | 14, 14, 14, 14, 14, 14, 14, 14 | none; none; none; none; none; none; none; none | 87.0 s elimination | 1, 5, 1, 5, 1, 5, 1, 5 |
| ring 8 | bunker / fortress | 0, 4 | 16.6 s | 0, 14 | 2 factory + 4 minion + 2 tower; none | 87.0 s elimination | 1, 2 |
| ring 8 | bunker / fortress | all | 11.8 s | 4, 14, 4, 14, 4, 14, 4, 14 | none; none; none; none; none; none; none; none | 89.1 s elimination | 1, 5, 1, 5, 1, 5, 1, 5 |
| ring 8 | snipewall / bunker | 0, 4 | 15.7 s | 9, 0 | none; 2 factory + 4 minion + 2 tower | 87.0 s elimination | 2, 1 |
| ring 8 | snipewall / bunker | all | 10.8 s | 9, 4, 9, 4, 9, 4, 9, 4 | none; none; none; none; none; none; none; none | 87.0 s elimination | 1, 6, 1, 7, 1, 7, 1, 5 |
| lanes 8 | fortress / fortress | 0, 4 | - | 14, 14 | none; none | 84.2 s elimination | 1, 1 |
| lanes 8 | fortress / fortress | all | 0.2 s | 14, 8, 8, 14, 14, 8, 8, 14 | none; 4 wall + 2 tower; 4 wall + 2 tower; none; none; 4 wall + 2 tower; 4 wall + 2 tower; none | 90.0 s timeout | 5, 1, 1, 5, 5, 1, 1, 5 |
| lanes 8 | bunker / fortress | 0, 4 | 18.6 s | 2, 14 | 2 tower + 4 minion; none | 84.2 s elimination | 1, 2 |
| lanes 8 | bunker / fortress | all | 0.2 s | 4, 14, 1, 14, 4, 14, 1, 14 | none; none; 1 tower + 2 factory + 1 minion; none; none; none; 1 tower + 2 factory + 1 minion; none | 90.0 s timeout | 3, 7, 1, 5, 3, 7, 1, 5 |
| lanes 8 | snipewall / bunker | 0, 4 | 17.2 s | 9, 3 | none; 1 tower + 4 minion | 86.0 s elimination | 2, 1 |
| lanes 8 | snipewall / bunker | all | 0.2 s | 9, 4, 3, 4, 9, 4, 3, 4 | none; none; 4 wall + 2 tower; none; none; none; 4 wall + 2 tower; none | 90.0 s timeout | 3, 7, 1, 5, 3, 7, 1, 5 |
| islands 8 | fortress / fortress | 0, 4 | - | 14, 14 | none; none | 78.0 s elimination | 1, 1 |
| islands 8 | fortress / fortress | all | 0.2 s | 14, 14, 14, 14, 14, 14, 14, 14 | none; none; none; none; none; none; none; none | 86.4 s elimination | 5, 1, 5, 1, 5, 1, 5, 1 |
| islands 8 | bunker / fortress | 0, 4 | 20.6 s | 1, 14 | 2 tower + 1 factory + 6 minion; none | 78.0 s elimination | 1, 2 |
| islands 8 | bunker / fortress | all | 0.2 s | 4, 14, 4, 14, 4, 14, 4, 14 | none; none; none; none; none; none; none; none | 86.4 s elimination | 5, 1, 5, 1, 5, 1, 5, 1 |
| islands 8 | snipewall / bunker | 0, 4 | 20.0 s | 9, 0 | none; 2 tower + 2 factory + 6 minion | 76.5 s elimination | 2, 1 |
| islands 8 | snipewall / bunker | all | 0.4 s | 9, 4, 9, 4, 9, 4, 9, 4 | none; none; none; none; none; none; none; none | 88.9 s elimination | 5, 1, 5, 1, 5, 1, 5, 1 |

Asserted on every row: fighters die in every battle, every side that sits it out is
reached by the circle, and a side with only walls left never places above a side with
fighters. Fortress mirrors on Duel, Corners, Ring 8 and Islands die to the circle at
78-87 s (shared places); in Triangle and Lanes the zones nearest the centre reach the
timeout with towers alive, exactly as the all-tower turtles do (walls are worth $0 there,
so the towers decide it).

### 2-team Lanes 8 with building armies

| team 0 | team 1 | round 0 (seeds 11, 4242) | round 1 (seeds 11, 4242) |
|---|---|---|---|
| fortress + swarm + wallrush + mixed | bricks + tanks + rush + snipers | team 1 at 80.5 s, 43.6 s | team 1 at 28.8 s, 32.3 s |
| bunker + snipewall + fortress + swarm | rush + rush + templates + turtle | team 0 at the 90 s timeout (both) | team 1 at 84.2 s (both) |

First hit at 1.2-1.7 s in every battle. Asserted: contact before sudden death, every
battle decided, the winning team has a fighter standing, and the building team wins some
and loses some.

### Ring 8 free-for-all with building armies

fortress, swarm, snipewall, wallrush, bunker, mixed, quad, rush; 8 rotations × 2 seeds.

- 1st places by army: **swarm 7**, bunker 5, fortress 4 (nobody else wins one).
- 1st places by zone index 0-7: 5, 0, 2, 0, 3, 1, 5, 0.

Asserted: no army takes more than half the 1st places, nobody wins every battle, and no
winner has only walls left. **Watch item:** like the turtle in the original free-for-all,
the armies that stay home outlast the chase-nearest soldier armies, and these battles run
to 76-87 s, so the Ring 8 corner zones (odd indices, further from the centre) rarely win:
the circle reaches them first. Rotation gives every player every zone over a match. Who
outlasts depends on the lineup: with no tower-only army present (fortress, tanks, swarm,
bricks, snipewall, rush, bunker, wallrush) the sealed fortress took or shared all 16 1st
places; with the turtle and the sniper nest in the lineup (bricks, tanks, turtle,
snipers, fortress, swarm, rush, wallrush) it took none (turtle 8, snipers 8). If it shows
up on the day, the lever is the same as for the turtle (smarter player code, the §9
damage/value bonuses), not wall prices: the sweep below found none that changes it.

### Tuning (M8.5): none needed, defaults confirmed

The first-guess defaults (wall `cost.wall.hp` 0.06, `cost.factory.minionDiscount` 0.5,
minion 40 HP / 5 damage / speed 1.5 / size 8, alive caps 4 per factory and 6 per player)
pass every assertion above, so **no config default, bound or coefficient was changed**:
the §6 reference tables, CLAUDE.md, `get_rules` and the cost tests stay as they are.
Sweeps that back this up (`tests/helpers/balance.ts` with config overrides):

- **Wall HP / price.** Sealed fortress with 11 walls of 50-400 HP and 2 or 3 towers vs
  rush / tanks / bricks: with 3 towers the rush only wins against 50-HP walls (11 × 150
  HP walls still hold it 14-2, 11 × 100 HP 10-6); with 2 towers the rush wins against
  ≤ 250 HP walls and splits 8-8 at 300 HP. So a price change only moves which HP kids
  buy, not who wins: making walls dear enough for the rush to beat a sealed box would
  price walls like soldier HP (≈ 0.25/HP) and make every partial wall build (already the
  weakest) useless. Cheaper walls (≈ 0.03/HP) buy a 4th tower: the sealed fortress then
  still loses 2-14 to the turtle, snipers, swarm, bunker and quad (sudden death decides
  those), so it doesn't break out either.
- **Minion damage 5 → 8** (minion $55 → $61, Swarm Factory $277 → $293): swarm 43% →
  43%, bunker 58% → 56%, quad 55% → 57%; no matchup against the bricks or tanks flips
  (minions lose to big bodies by design). Not worth re-pricing every factory.
- **Factories** sit at 43-58% with a minion discount of 0.5; nothing in the matrix asks
  for a different discount.

Engine time for the 1,097 battles with walls or factories in the matrix script (lean
runner, the sim alone): median 23 ms, max 359 ms per 5400-tick battle, at most 0.066 ms
per tick on average. Real-isolate timing of the buildings worst case (8 × (10 soldiers +
2 Swarm Factories + 12 walls), minions at the cap) is `tests/buildings-perf.test.ts` in
`npm run test:perf` (sim p99 < 8 ms/tick).

### Bots (`npm run bots`)

Two personalities use the new types: `fortress` (6 Stone Walls, $24 each, in a line
between Archers in front and Turrets behind) and `factory` (two Workshops, 250 HP /
interval 900, $184, behind Brawlers and Darts). Both are in the `mixed` rotation. Bot
soldiers skip walls as targets and smash an enemy wall that blocks them for 2 s, bot
factories rally on the nearest enemy, and placement keeps ≤ 6 walls (≤ 25% of the
budget), ≤ 2 factories and the 4 + 4 type caps.

## Minion kinds, squad orders and burst (M8.6)

Factories now pick a minion kind (`produces`), give their minions an order (`command`)
and can save them up (`burst`), plan §5.3. The harness factories follow the CLAUDE.md
examples: archers guard the nearest own tower, runners swarm the weakest enemy that isn't
a wall (burst 4), brutes swarm the enemy wall nearest the factory (then hunt like the
template), and the home guard defends. The kind stats are the §5.3 defaults (grunt 40 HP /
5 / melee / 1.5, archer 24 / 5 / 110 / 1.2, runner 28 / 4 / melee / 2.6, brute 100 / 8
(×3 on walls) / melee / 0.9).

### Kind archetypes ($1,000 budget each)

- **archers**: 4 Basic Walls, 1 Basic Tower, 2 Archer Nests (archer, interval 600, $333) guarding the tower, $992
- **runners**: 3 Basic Soldiers, 2 Runner Rushes (runner, interval 600, burst 4, $357) swarming the weakest enemy, $990
- **brutes**: 3 Basic Soldiers, 2 Brute Forges (brute, interval 600, $333) swarming the nearest enemy wall, $942
- **homeguard**: 2 Basic Towers, 2 Swarm Factories (grunt, $277) on defend, $950 (the bunker's army with `defend` instead of `rally`)
- not in the round robin: **trickle**, the runners with burst 1 ($990), for the burst comparison

### Round robin, 17 archetypes

Row W-D-L against the column (16 battles per pair: Corners 4 and Ring 8, two zone pairs,
both orders, seeds 11 and 4242). The 6×6 and 13×13 parts are unchanged from M6 and M8.5
(a pair's battles don't depend on who else is in the matrix; burst-1 grunt factories are
frame-identical to M8.5).

| vs | bricks | templates | tanks | turtle | scouts | snipers | fortress | snipewall | swarm | wallrush | mixed | quad | bunker | archers | runners | brutes | homeguard | beats |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| bricks | · | **16-0-0** | 7-0-9 | **16-0-0** | **16-0-0** | **16-0-0** | 2-0-14 | 8-0-8 | **16-0-0** | **11-0-5** | **16-0-0** | **16-0-0** | **16-0-0** | **16-0-0** | **16-0-0** | **16-0-0** | **16-0-0** | 13/16 |
| templates | 0-0-16 | · | 0-0-16 | 2-0-14 | **16-0-0** | 2-0-14 | 6-0-10 | **14-0-2** | 2-0-14 | 0-0-16 | **14-0-2** | 2-0-14 | 0-0-16 | **10-2-4** | **16-0-0** | 2-0-14 | 0-0-16 | 5/16 |
| tanks | **9-0-7** | **16-0-0** | · | 8-0-8 | **16-0-0** | **14-0-2** | 0-0-16 | 2-0-14 | **16-0-0** | **16-0-0** | **14-0-2** | **16-0-0** | **16-0-0** | **16-0-0** | **16-0-0** | **16-0-0** | **16-0-0** | 13/16 |
| turtle | 0-0-16 | **14-0-2** | 8-0-8 | · | **16-0-0** | 2-12-2 | **14-0-2** | **14-0-2** | 2-0-14 | **16-0-0** | **14-0-2** | 2-0-14 | 0-0-16 | 0-0-16 | **14-0-2** | 2-0-14 | 0-0-16 | 7/16 |
| scouts | 0-0-16 | 0-0-16 | 0-0-16 | 0-0-16 | · | **16-0-0** | 0-0-16 | 4-0-12 | **16-0-0** | 0-0-16 | 0-0-16 | **9-0-7** | **10-0-6** | **16-0-0** | **16-0-0** | **16-0-0** | **10-1-5** | 8/16 |
| snipers | 0-0-16 | **14-0-2** | 2-0-14 | 2-12-2 | 0-0-16 | · | **14-0-2** | **14-0-2** | **10-0-6** | 4-0-12 | **14-0-2** | 6-0-10 | 2-4-10 | 6-0-10 | **14-0-2** | **10-0-6** | 2-1-13 | 7/16 |
| fortress | **14-0-2** | **10-0-6** | **16-0-0** | 2-0-14 | **16-0-0** | 2-0-14 | · | **10-4-2** | 2-0-14 | **14-0-2** | **14-0-2** | 2-0-14 | 2-0-14 | 0-0-16 | 6-0-10 | 2-0-14 | 0-0-16 | 7/16 |
| snipewall | 8-0-8 | 2-0-14 | **14-0-2** | 2-0-14 | **12-0-4** | 2-0-14 | 2-4-10 | · | 2-0-14 | **14-0-2** | **14-0-2** | 2-0-14 | 2-0-14 | 0-0-16 | 6-0-10 | 6-0-10 | 2-0-14 | 4/16 |
| swarm | 0-0-16 | **14-0-2** | 0-0-16 | **14-0-2** | 0-0-16 | 6-0-10 | **14-0-2** | **14-0-2** | · | 0-0-16 | **14-0-2** | 0-0-16 | **9-0-7** | **16-0-0** | **16-0-0** | **14-0-2** | 0-0-16 | 9/16 |
| wallrush | 5-0-11 | **16-0-0** | 0-0-16 | 0-0-16 | **16-0-0** | **12-0-4** | 2-0-14 | 2-0-14 | **16-0-0** | · | **13-0-3** | **16-0-0** | **14-0-2** | **16-0-0** | **16-0-0** | **16-0-0** | **16-0-0** | 11/16 |
| mixed | 0-0-16 | 2-0-14 | 2-0-14 | 2-0-14 | **16-0-0** | 2-0-14 | 2-0-14 | 2-0-14 | 2-0-14 | 3-0-13 | · | 2-0-14 | 1-0-15 | 8-0-8 | **16-0-0** | **16-0-0** | 0-0-16 | 3/16 |
| quad | 0-0-16 | **14-0-2** | 0-0-16 | **14-0-2** | 7-0-9 | **10-0-6** | **14-0-2** | **14-0-2** | **16-0-0** | 0-0-16 | **14-0-2** | · | 2-0-14 | **10-0-6** | **16-0-0** | **16-0-0** | 2-0-14 | 10/16 |
| bunker | 0-0-16 | **16-0-0** | 0-0-16 | **16-0-0** | 6-0-10 | **10-4-2** | **14-0-2** | **14-0-2** | 7-0-9 | 2-0-14 | **15-0-1** | **14-0-2** | · | **16-0-0** | **16-0-0** | 3-0-13 | 0-1-15 | 9/16 |
| archers | 0-0-16 | 4-2-10 | 0-0-16 | **16-0-0** | 0-0-16 | **10-0-6** | **16-0-0** | **16-0-0** | 0-0-16 | 0-0-16 | 8-0-8 | 6-0-10 | 0-0-16 | · | 8-0-8 | 0-0-16 | 0-0-16 | 4/16 |
| runners | 0-0-16 | 0-0-16 | 0-0-16 | 2-0-14 | 0-0-16 | 2-0-14 | **10-0-6** | **10-0-6** | 0-0-16 | 0-0-16 | 0-0-16 | 0-0-16 | 0-0-16 | 8-0-8 | · | 0-0-16 | 2-0-14 | 2/16 |
| brutes | 0-0-16 | **14-0-2** | 0-0-16 | **14-0-2** | 0-0-16 | 6-0-10 | **14-0-2** | **10-0-6** | 2-0-14 | 0-0-16 | 0-0-16 | 0-0-16 | **13-0-3** | **16-0-0** | **16-0-0** | · | 8-0-8 | 7/16 |
| homeguard | 0-0-16 | **16-0-0** | 0-0-16 | **16-0-0** | 5-1-10 | **13-1-2** | **16-0-0** | **14-0-2** | **16-0-0** | 0-0-16 | **16-0-0** | **14-0-2** | **15-1-0** | **16-0-0** | **14-0-2** | 8-0-8 | · | 11/16 |

| archetype | wins vs the six | vs the M8.5 13 | vs all 16 |
|---|---|---|---|
| bricks | 71/80 (89%) | 156/192 (81%) | 220/256 (86%) |
| templates | 20/80 (25%) | 58/192 (30%) | 86/256 (34%) |
| tanks | 63/80 (79%) | 143/192 (74%) | 207/256 (81%) |
| turtle | 40/80 (50%) | 102/192 (53%) | 118/256 (46%) |
| scouts | 16/80 (20%) | 55/192 (29%) | 113/256 (44%) |
| snipers | 18/80 (23%) | 82/192 (43%) | 114/256 (45%) |
| fortress | - | 104/192 (54%) | 112/256 (44%) |
| snipewall | - | 76/192 (40%) | 90/256 (35%) |
| swarm | - | 85/192 (44%) | 131/256 (51%) |
| wallrush | - | 112/192 (58%) | 176/256 (69%) |
| mixed | - | 36/192 (19%) | 76/256 (30%) |
| quad | - | 105/192 (55%) | 149/256 (58%) |
| bunker | - | 114/192 (59%) | 149/256 (58%) |
| **archers** | - | - | 84/256 (33%) |
| **runners** | - | - | 34/256 (13%) |
| **brutes** | - | - | 113/256 (44%) |
| **homeguard** | - | - | 179/256 (70%, 69.9%) |

Asserted (`tests/balance.test.ts`): every M6 and M8.5 assertion and cap on their own parts,
unchanged; on the full 17×17 matrix nobody beats everyone, everyone beats someone and loses
to someone, and nobody wins more than 70% except the two big-body soldier armies, capped
at today's numbers (bricks 220/256, tanks 207/256: they beat every kind archetype 16-0,
since 24-110 HP minions barely scratch 250-430 HP bodies); no exception for any building
or kind archetype; no walls-only win. Stated outcomes, all asserted:

- **Brutes break the sealed fortress:** 14-0-2 (the brute swarm smashes a seal wall in
  about 4 s, the soldiers walk in). The M8.5 melee armies lose to it (bricks 2-14, tanks 0-16).
- **Archers shoot over walls:** 16-0 against the turtle, the sealed fortress and the walled
  sniper nest. They lose to every melee army that reaches them (24 HP each), including the
  rush (0-16, checked separately).
- **Defend beats attack for a tower bunker:** the home guard beats the bunker 15-1-0 (its
  grunts screen the towers instead of running at the nearest enemy) and is the best
  non-soldier archetype at 69.9%, just under the 70% cap: a **watch item** (a smaller
  `factory.defendRadius` barely moves it: 140 and 120 px both give 69.1%).
- **Bursts pay:** see the next table: the burst-4 runners win 38 of 256 vs 30 for the
  same runners sent one at a time, and lose 11.2 minions per KO vs 16.5.

### Minion output

Against every round-robin archetype (all sites, both orders, both seeds; `scripts/balance-matrix.ts`):

| army | wins | minions made | lost | minion KOs | minion damage | damage per minion | lost per KO |
|---|---|---|---|---|---|---|---|
| archers | 73/240 | 1144 | 910 | 208 | 17460 | 15.3 | 4.4 |
| runners (burst 4) | 38/256 | 2109 | 2002 | 179 | 7063 | 3.3 | 11.2 |
| trickle (burst 1) | 30/256 | 2182 | 2144 | 130 | 7422 | 3.4 | 16.5 |
| brutes | 98/240 | 2444 | 2145 | 634 | 58993 | 24.1 | 3.4 |
| homeguard | 166/240 | 1446 | 620 | 288 | 14173 | 9.8 | 2.2 |
| swarm (M8.5, grunts on rally) | 115/240 | 2427 | 2066 | 326 | 20819 | 8.6 | 6.3 |
| bunker (M8.5, grunts on rally) | 128/240 | 2692 | 2316 | 259 | 21341 | 7.9 | 8.9 |

(Rows that are in the round robin don't play themselves: 240 battles.) Brutes deal the
most per minion because a third of their hits land on walls (×3); defenders lose the
fewest minions.

### Ring 8 free-for-all with minion-kind armies

archers, runners, brutes, homeguard, swarm, fortress, quad, rush; 8 rotations × 2 seeds.

- 1st places by army: homeguard 8, brutes 5, rush 3.
- 1st places by zone index 0-7: 3, 3, 4, 2, 1, 0, 3, 0.

Asserted: no army takes more than half the 1st places (the home guard sits exactly at
half: a watch item, like the turtle in the M6 free-for-all: armies that stay home outlast
the others), several armies win, and no winner has only walls left.

### Tuning (M8.6): defaults kept

Every assertion passes with the first-guess kind stats, so no default was changed beyond
the §5.3 design (the brute's HP was set to 100 instead of 110 before the matrix ran, so
it stays inside a soldier-bound retune to `maxHealth.max` 100 that the API tests use).
Sweeps on the weak spot, the runner swarm (13%):

- **Runner stats** (all with the swarm-the-weakest brain and burst 4): 36 HP / 6 / speed
  2.2 ($33 each) 16.4%; 32 HP / 6 / 2.4 ($37) 16.8%; 40 HP / 6 / 2.0 / size 7 ($35)
  17.2%. Stats hardly matter: the army's results are set by its plan.
- **Orders:** the same runners on `rally` (attack) win 62 of 256 (24%, 4.5 damage per
  runner); grunts on swarm-the-weakest drop from 124 to 81 wins of 256 (9.2 vs 10.9
  damage per grunt). Swarming the weakest enemy runs every minion past the defenders, so
  it is a sniper-hunting trick (the runners beat the sealed fortress and the walled sniper
  nest 10-6), not a general plan. CLAUDE.md and `get_rules` say so: "swarm is for one
  target; attack is the all-rounder".
- **Archers** 30 HP / 6 / range 100 ($34 each): 34.0% vs 32.8%; kept.
- **Composition:** runner factories at the template's pace (interval 900, 4 soldiers) did
  worse (11.8%): the soldiers are the runners' screen.

Engine time for the 2,041 battles with walls or factories in the matrix script (lean
runner, the sim alone): median 27 ms, max 516 ms per 5400-tick battle, at most 0.100 ms
per tick on average. Real-isolate timing of the kinds worst case (8 players, 10 soldiers +
2 kind factories with bursts and all four orders + 12 walls each) is the second test in
`tests/buildings-perf.test.ts` (`npm run test:perf`, sim p99 < 8 ms/tick). On the devcontainer (quiet machine) it ran at p50 1.84 ms, **p99 5.6 ms** per tick (8 bursts, all four kinds, 15 minions at once), next to 5.2 ms for the M8.5 worst case. Under heavy load from other processes both reached 8-11 ms, so run the timing pass on an idle machine.

### Bots (`npm run bots`, M8.6)

Three new personalities join the `mixed` rotation: `archers` (an Archer Nest guarding
Turrets behind Stone Walls), `runners` (a burst-4 Runner Pack swarming the weakest enemy,
with Brawlers and Darts) and `brutes` (a Brute Smithy swarming the nearest enemy wall, with
Brawlers and Stone Walls). Their factories (250 HP, interval 900: $219 / $234 / $219)
release stored minions early when the factory drops below half health.


## Routing round walls (M8.7)

Units now path round walls (plan §9.3 Routing round walls): a soldier or minion walks
the shortest open way to its destination and only presses on (and smashes) a wall when
the destination is walled off. Every number in this file above the M8.7 heading that
involves walls was measured with the old slide-only steering; the round robin and the
free-for-alls below are the current numbers (`scripts/balance-matrix.ts`).

### What routing changed

- **Open walls no longer stop melee.** Walls that don't enclose anything are now just
  obstacles: the walled sniper nest (6 walls in the front cells) fell from 40% to 21%
  round-robin wins, beaten by every melee army that used to get stuck smashing its walls
  (bricks 8-8 → 16-0, tanks 2-14 → 11-5, walls + rush 2-14 → 16-0).
- **The "sealed" fortress wasn't sealed on N/S/E/W zones.** Its 11 walls (front row + both
  flanks) left rows 4-5 of the flanks open; closing a whole edge zone takes 16 walls, above
  the cap of 12. The slide steering never found that back door, routing does (the rush
  went from 0 to 6 wins of 16 against it).
- **Own walls stop slowing their own army.** Walls + rush's 9 soldiers walk out round
  their 4 front walls instead of queueing behind them.

### Fixes (bot archetypes, not config)

Both changes make the archetypes mean what their names say in a routing world; no
config value changed (`sim.replanTicks` = 10 is new, everything else is as in M8.6):

- `fortress`: on N/S/E/W zones whose back row is the arena edge the 11 walls now close a
  pocket of rows 3-5 × cols 1-4 against the edge (row 2 cols 1-4, both flanks of rows 3-5,
  one spare doubling (2, 2)), the most forward seal 11 walls allow; elsewhere (Lanes) a
  7-wall ring round an L of three cells plus 4 walls doubling the front. Diagonal zones are
  unchanged. Result: the rush wins 0 of 16 again.
- `snipewall` ("walled sniper nest"): the 6 walls close the 3 towers into the back corner
  (diagonal zones: (4,4)-(5,5) behind (3,4), (3,5), (4,3), (5,3), doubled at (2,4), (4,2))
  or the back edge ((1..3,5) behind (0,5), (4,5), (1..3,4), doubled at (2,3)); Lanes keeps
  the front cells (6 walls can't close a pocket away from the edge).

### Round robin (17 archetypes, 256 battles each)

| archetype | vs the six | vs the M8.5 13 | vs all 16 | M8.6 (all 16) |
|---|---|---|---|---|
| bricks | 71/80 (89%) | 145/192 (76%) | 209/256 (82%) | 220/256 (86%) |
| templates | 20/80 (25%) | 58/192 (30%) | 86/256 (34%) | 86/256 (34%) |
| tanks | 63/80 (79%) | 140/192 (73%) | 204/256 (80%) | 207/256 (81%) |
| turtle | 40/80 (50%) | 104/192 (54%) | 120/256 (47%) | 118/256 (46%) |
| scouts | 16/80 (20%) | 68/192 (35%) | 126/256 (49%) | 113/256 (44%) |
| snipers | 18/80 (23%) | 88/192 (46%) | 116/256 (45%) | 114/256 (45%) |
| fortress | - | 99/192 (52%) | 103/256 (40%) | |
| snipewall | - | 72/192 (38%) | 76/256 (30%) | |
| swarm | - | 89/192 (46%) | 135/256 (53%) | |
| wallrush | - | 119/192 (62%) | **183/256 (71.5%)** | 176/256 (69%) |
| mixed | - | 36/192 (19%) | 78/256 (30%) | |
| quad | - | 98/192 (51%) | 146/256 (57%) | |
| bunker | - | 116/192 (60%) | 151/256 (59%) | |
| archers | - | - | 75/256 (29%) | |
| runners | - | - | 48/256 (19%) | |
| brutes | - | - | 115/256 (45%) | |
| homeguard | - | - | **181/256 (70.7%)** | 179/256 (69.9%) |

The six (no walls) are unchanged battle for battle. The 13×13 part passes every M8.5
assertion and cap (bricks 145 ≤ 156, tanks 140 ≤ 143). In the 17×17 part two archetypes
sit just above the 70% cap:

- **walls + rush 183/256 (71.5%)**: it beats every kind archetype 16-0 (as in M8.6) and now
  beats the bricks 11-5 (was 5-11): its soldiers leave round their own walls together.
- **grunt home guard 181/256 (70.7%)**: +2 from the walled sniper nest (the M8.6 watch item
  at 69.9%).

No price-neutral config knob moves them below the cap: `sim.replanTicks` 5-15 gives walls +
rush 177-184, `factory.defendRadius` 140-180 gives the home guard 177-182, and prices don't
change these fixed archetypes' battles. They are recorded as capped exceptions in
`KIND_DOMINANCE_EXCEPTIONS` at today's numbers (**the only building/kind exceptions; an open
decision for the event: accept them, or retune the soldier price / minion stats**).

### Stated outcomes, Lanes and free-for-alls

- Rush vs open U fortress 16/16, vs the sealed fortress 0/16; brutes break the sealed
  fortress 14-2; archers beat the turtle, fortress and walled sniper nest 16-0; home guard
  beats the bunker 15-1-0; turtle vs rush: the rush wins (Lanes too).
- 2-team Lanes with building armies: the building team wins the bunker + snipewall +
  fortress + swarm case in round 0 (90 s timeout) and loses the others.
- Ring 8 free-for-all with building armies: fortress 7, swarm 6, bunker 2, walls + rush 1,
  quad 1 (was swarm 7, bunker 5, fortress 4). With minion kinds: brutes 5, home guard 5,
  swarm 3, rush 2, fortress 1.
- Engine time: 2,041 battles with walls or factories, median 26 ms, max 358 ms per battle
  (routing included).

### Performance (timing pass, `tests/buildings-perf.test.ts`)

| case (8 players, Ring 8, 1,900 ticks, real isolates) | p50 | p99 | max |
|---|---|---|---|
| M8.5 buildings worst case | 1.88 ms | 4.93 ms | 15.8 ms |
| M8.6 kinds, orders, bursts | 1.88 ms | 5.62 ms | 10.3 ms |
| **M8.7 maze** (12 walls per zone in a U, an L and blocks; 236 bodies; 3,166 plans, 103 fields built, 413 cache hits) | 1.86 ms | 5.72 ms | 10.4 ms |

Before routing the first two measured p99 5.45 / 5.64 ms on the same machine: routing costs
no measurable time. Target unchanged: p99 < 8 ms/tick.


## Elements, splash, support and the ×5 economy (M8.8)

Plan §14 "M8.8 balance". Everything here is on the **default config after the M8.8 balance
retune** (below): $5,000 budget, $2,500 cap, 16 battles per pair (Corners 4 + Ring 8, two
zone pairs, both orders, seeds 11 and 4242). `tests/balance.test.ts` plays one seed (8 per
pair) by default and both with `BALANCE_FULL=1`; the 37-archetype round robin (10,656
battles at 16 per pair) is shared out over worker processes (`tests/helpers/balanceWorker.ts`,
`BALANCE_WORKERS`, default cores − 2, at most 8): about 90 s wall clock on a 10-core box.
`npx tsx --conditions=source scripts/balance-matrix.ts` prints every table below.

### Archetypes (37)

- **The M8.7 17, refit at ×5** (copies dropped until they fit $5,000): bricks are the
  max-cost HP × damage unit (1,700 HP / 270 dmg, $2,480), tanks are 4 Half Tanks (5 cost
  $5,610), walls + rush has 8 soldiers, all four templates 4 soldiers, the brute breakers 2
  soldiers, the archer nest 2 walls, the runner swarm 2 soldiers. The M8.7 layouts (the
  sealed fortress's back pocket or 7-wall ring, the nest towers closed into the back) stay.
- **Specialists** (a maxed stat now costs 2×, was 3×): `hugetanks` (2 Huge Tanks), `glass`
  (3 Glass Cannons + 1 soldier), `longbow` (2 Max Snipers + 2 soldiers) and the stress army
  `scoutsFilled` (11 Scouts with HP raised until 11 fill the budget: 340 HP).
- **Elements and support** (the spec's example armies, plus the requested fire splash nest
  and ice wall + snipers): fire squad, shatter squad, frost nest, storm crowd, mortar battery,
  fire splash nest, ice wall + snipers, bombard, blizzard + fire, healer ball, buffed rush,
  shield wall, Huge Tank + friends, elemental factories, storm runners, medic tent + tanks.
  Every army costs 85-100% of the budget (checked).

**Bots** (fake-runner brains, the CLAUDE.md templates): medics cleanse a burning or frozen
ally first, then heal the lowest hp fraction in reach, otherwise they stay with the nearest
fighting ally; aura units (drummer, banner, shield bearer) stay with the nearest fighting
ally and hit what comes close; fire soldiers and towers hit a frozen enemy first; splash
units hit the enemy with the most other enemies round it; the medic tent guards the
toughest soldier. Three armies built round a tower (blizzard + fire, frost nest, Huge Tank +
friends) keep their soldiers by their towers (`soldierBrain: 'hold'`): their combos need it.

### Tuning (config): the spec's knobs, in its order

Measured first with the spec's numbers on the routing engine:

| step | change | why | result |
|---|---|---|---|
| 1 | none (the spec's config) | | scout stress army 70.3% (405/576), over the cap |
| 2 | `cost.speed` 60 → **66** | the spec's first knob for the scout swarm | padded scouts 390 → 340 HP: **58%** |
| 3 | `cost.range` 1.45 → **1.38** | speed 66 makes the Basic Soldier $532, and 4 soldiers + 3 towers $5,038; the tower gets $16 cheaper instead (the spec moved the tower itself for the same reason) | templates $4,978; the longbow army 65% |
| 4 | grunt HP 200 → **180** | the spec's home-guard knob: the home guard took 9 of 16 kind free-for-alls (cap: half) | **8 of 16** |

`cost.factory.minionDiscount` (the spec's first home-guard knob) changes no battle of a fixed
army, so it was left at 0.5. The element and support constants are the spec's, unchanged
(`elements.lightning.chancePct` 30 and `elements.shatterPct` 30 were tried and moved the
storm crowd and the shatter squad by 1-3 points only: their dominance was army shape, see
below). New prices: Basic Soldier **$529**, Basic Tower **$954**, Basic Factory **$987**
(grunt $148), Fire Soldier $635, Field Medic $759, War Drummer $603; the plan's §6 tables
are re-printed from `final-retune/tables.mjs`.

### Fixes (bot archetypes and one reference unit, not config)

Before these, on the spec's config: storm crowd 86.8%, bricks 82.5%, shatter squad 77.0%,
padded scouts 76.8%, tanks 75.6%, walls + rush 74.3%, buffed rush 71.0%; shield wall 13%,
mortar nest 32%.

- **Frost Archer range 150 → 140.** The spec shortened the Basic Tower to 140 for the budget,
  which left its 150-range Frost Archer just out of every tower's reach: two of them beat any
  tower army alone and the shatter squad won 77%. At 140 they trade shots: **64%**. (A
  soldier with range > 140 still out-ranges the Basic Tower: that is a real kite counter.)
- **Storm crowd: 7 Lightning Soldiers** (the §11.1 rule: they cost 89%, no Basic Soldier
  filler). With the filler it was the only 8-body soldier blob in the matrix (76-88%).
- **Mortar battery** (4 Mortar Towers) instead of 2 mortars + 3 soldiers + 4 walls in a line
  (31% → **60%**); **shield wall** = 2 Shield Bearers in front of 3 towers instead of a
  6-wall line routing walks round (13% → **51%**).
- **Hold by the tower** for blizzard + fire (36% → **61%**), frost nest (43% → **56%**) and
  Huge Tank + friends (33% → **54%**).
- **New:** fire splash nest (6 walls closing in 2 Fire Mortars + 1 tower) and ice wall +
  snipers (6 walls closing in a Frost Sniper, an Ice Tower and a tower), the requested
  walled element nests: both beat every soldier blob 16-0.

### Round robin (37 archetypes, 576 battles each)

| archetype | wins vs the six | wins vs the M8.5 13 | wins vs the M8.6 17 | wins vs all 36 | beats | loses to |
|---|---|---|---|---|---|---|
| bricks | 53/80 (66%) | 124/192 (65%) | 188/256 (73%) | 410/576 (71%) | 25 | snipers, fortress, snipewall, wallrush, longbow, shatter, frostnest, firenest, icewall, blizzard |
| tanks | 40/80 (50%) | 115/192 (60%) | 179/256 (70%) | 380/576 (66%) | 23 | bricks, turtle, snipers, fortress, snipewall, longbow, frostnest, mortars, firenest, icewall, bombard, shieldwall |
| snipers | 40/80 (50%) | 121/192 (63%) | 147/256 (57%) | 375/576 (65%) | 25 | scouts, bunker, archers, homeguard, scoutsFilled, bigFriends, elemfactories |
| longbow | - | - | - | 373/576 (65%) | 22 | turtle, snipers, bunker, archers, brutes, homeguard, scoutsFilled, frostnest, mortars, bombard, blizzard, shieldwall, bigFriends |
| wallrush | - | 113/192 (59%) | 177/256 (69%) | 366/576 (64%) | 23 | tanks, turtle, snipers, fortress, snipewall, longbow, storm, mortars, firenest, icewall, bombard, blizzard, shieldwall |
| shatter | - | - | - | 366/576 (64%) | 22 | tanks, turtle, snipers, fortress, snipewall, wallrush, longbow, storm, mortars, firenest, bombard, buffedrush, shieldwall |
| storm | - | - | - | 354/576 (61%) | 22 | bricks, tanks, turtle, snipers, fortress, snipewall, longbow, mortars, firenest, icewall, bombard, blizzard, shieldwall |
| blizzard | - | - | - | 353/576 (61%) | 22 | snipers, swarm, bunker, archers, brutes, homeguard, shatter, mortars, healerball, elemfactories, stormrunners |
| mortars | - | - | - | 348/576 (60%) | 22 | bricks, swarm, quad, bunker, archers, brutes, homeguard, frostnest, bigFriends, elemfactories, stormrunners |
| homeguard | - | - | 169/256 (66%) | 347/576 (60%) | 22 | bricks, tanks, scouts, wallrush, brutes, hugetanks, glass, scoutsFilled, shatter, storm, healerball, buffedrush, elemfactories |
| buffedrush | - | - | - | 345/576 (60%) | 22 | bricks, tanks, turtle, snipers, fortress, snipewall, wallrush, longbow, mortars, firenest, icewall, bombard, blizzard |
| scoutsFilled | - | - | - | 335/576 (58%) | 19 | bricks, tanks, turtle, fortress, snipewall, wallrush, firesquad, shatter, storm, mortars, firenest, icewall, bombard, blizzard, healerball, buffedrush, shieldwall |
| turtle | 54/80 (68%) | 112/192 (58%) | 128/256 (50%) | 328/576 (57%) | 21 | swarm, quad, bunker, archers, brutes, homeguard, frostnest, blizzard, bigFriends, elemfactories, stormrunners |
| frostnest | - | - | - | 322/576 (56%) | 20 | swarm, wallrush, quad, bunker, archers, brutes, homeguard, scoutsFilled, shatter, storm, blizzard, buffedrush, bigFriends, elemfactories, stormrunners |
| bombard | - | - | - | 322/576 (56%) | 20 | bricks, turtle, snipers, swarm, quad, bunker, archers, brutes, homeguard, frostnest, mortars, shieldwall, bigFriends, elemfactories, stormrunners |
| bigFriends | - | - | - | 311/576 (54%) | 21 | bricks, tanks, wallrush, archers, brutes, homeguard, scoutsFilled, shatter, storm, blizzard, healerball, buffedrush, elemfactories, stormrunners |
| bunker | - | 107/192 (56%) | 137/256 (54%) | 300/576 (52%) | 19 | bricks, tanks, scouts, swarm, wallrush, brutes, homeguard, hugetanks, glass, scoutsFilled, shatter, storm, healerball, buffedrush, bigFriends, elemfactories |
| swarm | - | 108/192 (56%) | 156/256 (61%) | 298/576 (52%) | 19 | bricks, tanks, scouts, snipers, wallrush, homeguard, hugetanks, glass, longbow, scoutsFilled, firesquad, shatter, storm, healerball, buffedrush, medictent |
| shieldwall | - | - | - | 293/576 (51%) | 20 | bricks, snipers, swarm, quad, bunker, archers, brutes, homeguard, frostnest, blizzard, buffedrush, bigFriends, elemfactories, stormrunners |
| healerball | - | - | - | 288/576 (50%) | 18 | bricks, tanks, turtle, snipers, fortress, snipewall, wallrush, glass, longbow, shatter, frostnest, storm, mortars, firenest, icewall, bombard, buffedrush, shieldwall |
| firesquad | - | - | - | 286/576 (50%) | 17 | bricks, tanks, turtle, snipers, fortress, wallrush, homeguard, longbow, shatter, frostnest, storm, mortars, bombard, blizzard, healerball, buffedrush, shieldwall, bigFriends |
| fortress | - | 100/192 (52%) | 104/256 (41%) | 282/576 (49%) | 18 | turtle, snipers, swarm, quad, bunker, archers, runners, brutes, homeguard, longbow, frostnest, mortars, bombard, blizzard, shieldwall, bigFriends, elemfactories, stormrunners |
| brutes | - | - | 122/256 (48%) | 278/576 (48%) | 19 | bricks, tanks, scouts, swarm, wallrush, mixed, quad, hugetanks, glass, scoutsFilled, firesquad, shatter, storm, healerball, buffedrush, medictent |
| quad | - | 82/192 (43%) | 130/256 (51%) | 269/576 (47%) | 16 | bricks, tanks, scouts, snipers, swarm, wallrush, bunker, homeguard, hugetanks, glass, longbow, scoutsFilled, firesquad, shatter, storm, healerball, buffedrush, bigFriends, medictent |
| elemfactories | - | - | - | 268/576 (47%) | 17 | bricks, templates, tanks, scouts, swarm, wallrush, mixed, quad, brutes, hugetanks, glass, scoutsFilled, firesquad, shatter, storm, healerball, buffedrush, medictent |
| scouts | 23/80 (29%) | 87/192 (45%) | 151/256 (59%) | 238/576 (41%) | 13 | bricks, templates, tanks, turtle, fortress, snipewall, wallrush, glass, longbow, scoutsFilled, firesquad, shatter, frostnest, storm, mortars, firenest, icewall, bombard, blizzard, healerball, buffedrush, shieldwall, bigFriends |
| archers | - | - | 92/256 (36%) | 234/576 (41%) | 15 | bricks, templates, tanks, scouts, swarm, wallrush, mixed, quad, bunker, brutes, homeguard, hugetanks, glass, scoutsFilled, firesquad, shatter, storm, healerball, buffedrush, elemfactories, medictent |
| glass | - | - | - | 230/576 (40%) | 13 | bricks, tanks, turtle, snipers, fortress, snipewall, wallrush, hugetanks, longbow, scoutsFilled, firesquad, shatter, frostnest, storm, mortars, firenest, icewall, bombard, blizzard, buffedrush, shieldwall, bigFriends |
| templates | 18/80 (23%) | 57/192 (30%) | 90/256 (35%) | 205/576 (36%) | 11 | bricks, tanks, turtle, snipers, fortress, swarm, wallrush, quad, bunker, brutes, homeguard, longbow, scoutsFilled, firesquad, shatter, frostnest, storm, mortars, bombard, blizzard, healerball, buffedrush, shieldwall, bigFriends |
| firenest | - | - | - | 204/576 (35%) | 12 | templates, turtle, snipers, fortress, swarm, mixed, quad, bunker, archers, runners, brutes, homeguard, longbow, firesquad, frostnest, mortars, bombard, blizzard, shieldwall, bigFriends, elemfactories, stormrunners |
| snipewall | - | 70/192 (36%) | 70/256 (27%) | 200/576 (35%) | 12 | templates, turtle, snipers, fortress, swarm, mixed, quad, bunker, archers, runners, brutes, homeguard, longbow, firesquad, frostnest, mortars, bombard, blizzard, shieldwall, bigFriends, elemfactories, stormrunners |
| icewall | - | - | - | 196/576 (34%) | 11 | templates, turtle, snipers, fortress, swarm, mixed, quad, bunker, archers, runners, brutes, homeguard, longbow, firesquad, frostnest, mortars, bombard, blizzard, shieldwall, bigFriends, elemfactories, stormrunners |
| hugetanks | - | - | - | 182/576 (32%) | 12 | bricks, templates, tanks, turtle, scouts, snipers, fortress, snipewall, wallrush, longbow, scoutsFilled, firesquad, shatter, frostnest, storm, mortars, firenest, icewall, bombard, blizzard, healerball, buffedrush, shieldwall, bigFriends |
| stormrunners | - | - | - | 180/576 (31%) | 11 | bricks, templates, tanks, scouts, snipers, swarm, wallrush, mixed, quad, bunker, archers, runners, brutes, hugetanks, glass, longbow, scoutsFilled, firesquad, shatter, storm, healerball, buffedrush, elemfactories, medictent |
| mixed | - | 36/192 (19%) | 80/256 (31%) | 168/576 (29%) | 8 | bricks, templates, tanks, turtle, scouts, snipers, fortress, swarm, wallrush, quad, bunker, homeguard, hugetanks, glass, longbow, scoutsFilled, firesquad, shatter, frostnest, storm, mortars, bombard, blizzard, healerball, buffedrush, shieldwall, bigFriends, medictent |
| medictent | - | - | - | 144/576 (25%) | 8 | bricks, templates, tanks, turtle, scouts, snipers, fortress, snipewall, wallrush, bunker, homeguard, hugetanks, glass, longbow, scoutsFilled, firesquad, shatter, frostnest, storm, mortars, firenest, icewall, bombard, blizzard, healerball, buffedrush, shieldwall, bigFriends |
| runners | - | - | 39/256 (15%) | 101/576 (18%) | 5 | bricks, templates, tanks, turtle, scouts, snipers, swarm, wallrush, mixed, quad, bunker, archers, brutes, homeguard, hugetanks, glass, longbow, scoutsFilled, firesquad, shatter, frostnest, storm, mortars, bombard, blizzard, healerball, buffedrush, shieldwall, bigFriends, elemfactories, medictent |

Open item 7 is resolved: **walls + rush 64% and the grunt home guard 60%** (69% and 66% in
the 17); their exceptions are deleted. The tank exceptions are gone too (66%). The only
archetype over 70% is **bricks, 71% (73% in the 17)**, the one key left in the test,
re-recorded at the measured number and below the M8.6 cap (220/256). Every archetype beats
someone and loses to someone; nobody beats everyone; no battle is won with walls alone.
The six among themselves need no exception (bricks 66%); the turtle is unbeaten there (it
draws the bricks 8-8 and the snipers 2-12-2) and loses to 11 archetypes in the full matrix.

<details><summary>The full 37 × 37 matrix (row W-D-L against column)</summary>

| vs | bricks | templates | tanks | turtle | scouts | snipers | fortress | snipewall | swarm | wallrush | mixed | quad | bunker | archers | runners | brutes | homeguard | hugetanks | glass | longbow | scoutsFilled | firesquad | shatter | frostnest | storm | mortars | firenest | icewall | bombard | blizzard | healerball | buffedrush | shieldwall | bigFriends | elemfactories | stormrunners | medictent | beats |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| bricks | · | **16-0-0** | **12-0-4** | 8-0-8 | **11-0-5** | 6-0-10 | 2-0-14 | 0-0-16 | **16-0-0** | 5-0-11 | **16-0-0** | **16-0-0** | **16-0-0** | **16-0-0** | **16-0-0** | **16-0-0** | **16-0-0** | **16-0-0** | **16-0-0** | 2-0-14 | **11-0-5** | **16-0-0** | 4-0-12 | 5-0-11 | **14-0-2** | **16-0-0** | 0-0-16 | 0-0-16 | **16-0-0** | 3-0-13 | **16-0-0** | **9-0-7** | **14-0-2** | **16-0-0** | **16-0-0** | **16-0-0** | **16-0-0** | 25/36 |
| templates | 0-0-16 | · | 0-0-16 | 2-0-14 | **14-0-2** | 2-0-14 | 6-0-10 | **14-0-2** | 2-0-14 | 0-0-16 | **14-0-2** | 3-0-13 | 0-0-16 | **13-0-3** | **16-0-0** | 4-0-12 | 0-0-16 | **12-0-4** | 8-0-8 | 2-0-14 | 4-0-12 | 2-7-7 | 0-0-16 | 2-0-14 | 1-0-15 | 2-0-14 | **14-0-2** | **14-0-2** | 2-0-14 | 2-0-14 | 1-0-15 | 1-0-15 | 2-0-14 | 2-0-14 | **16-0-0** | **16-0-0** | **12-0-4** | 11/36 |
| tanks | 4-0-12 | **16-0-0** | · | 2-0-14 | **16-0-0** | 2-0-14 | 0-0-16 | 0-0-16 | **16-0-0** | **15-0-1** | **12-0-4** | **16-0-0** | **16-0-0** | **16-0-0** | **16-0-0** | **16-0-0** | **16-0-0** | **16-0-0** | **15-0-1** | 0-0-16 | **14-0-2** | **16-0-0** | **14-0-2** | 5-0-11 | **15-0-1** | 0-0-16 | 0-0-16 | 0-0-16 | 0-0-16 | 8-0-8 | **16-0-0** | **14-0-2** | 6-0-10 | **14-0-2** | **16-0-0** | **16-0-0** | **16-0-0** | 23/36 |
| turtle | 8-0-8 | **14-0-2** | **14-0-2** | · | **16-0-0** | 2-12-2 | **14-0-2** | **16-0-0** | 2-0-14 | **12-0-4** | **14-0-2** | 0-0-16 | 0-0-16 | 0-0-16 | **14-0-2** | 2-0-14 | 0-0-16 | **16-0-0** | **16-0-0** | **10-4-2** | **12-0-4** | **14-0-2** | **14-0-2** | 2-8-6 | **12-0-4** | 2-12-2 | **16-0-0** | **16-0-0** | **10-4-2** | 6-0-10 | **16-0-0** | **12-0-4** | 2-12-2 | 6-0-10 | 0-0-16 | 2-0-14 | **16-0-0** | 21/36 |
| scouts | 5-0-11 | 2-0-14 | 0-0-16 | 0-0-16 | · | **16-0-0** | 0-0-16 | 0-0-16 | **16-0-0** | 0-0-16 | **16-0-0** | **16-0-0** | **16-0-0** | **16-0-0** | **16-0-0** | **16-0-0** | **16-0-0** | **15-0-1** | 2-0-14 | 3-0-13 | 0-0-16 | 6-0-10 | 0-0-16 | 5-0-11 | 0-0-16 | 0-0-16 | 0-0-16 | 0-0-16 | 0-0-16 | 0-0-16 | 1-0-15 | 2-0-14 | 0-0-16 | 5-0-11 | **16-0-0** | **16-0-0** | **16-0-0** | 13/36 |
| snipers | **10-0-6** | **14-0-2** | **14-0-2** | 2-12-2 | 0-0-16 | · | **14-0-2** | **16-0-0** | **10-0-6** | **15-0-1** | **14-0-2** | **10-0-6** | 2-4-10 | 2-0-14 | **14-0-2** | 8-0-8 | 2-1-13 | **16-0-0** | **16-0-0** | **14-0-2** | 0-0-16 | **14-0-2** | **16-0-0** | 6-4-6 | **16-0-0** | 2-12-2 | **16-0-0** | **16-0-0** | **10-4-2** | **10-0-6** | **16-0-0** | **16-0-0** | **6-8-2** | 6-0-10 | 6-0-10 | **10-0-6** | **16-0-0** | 25/36 |
| fortress | **14-0-2** | **10-0-6** | **16-0-0** | 2-0-14 | **16-0-0** | 2-0-14 | · | **14-0-2** | 0-0-16 | **16-0-0** | **10-0-6** | 0-0-16 | 0-0-16 | 0-0-16 | 2-0-14 | 2-0-14 | 0-0-16 | **16-0-0** | **16-0-0** | 2-0-14 | **16-0-0** | **10-0-6** | **12-0-4** | 2-0-14 | **16-0-0** | 2-0-14 | **14-0-2** | **14-0-2** | 2-0-14 | 2-0-14 | **16-0-0** | **16-0-0** | 2-0-14 | 2-0-14 | 0-0-16 | 2-0-14 | **16-0-0** | 18/36 |
| snipewall | **16-0-0** | 2-0-14 | **16-0-0** | 0-0-16 | **16-0-0** | 0-0-16 | 2-0-14 | · | 0-0-16 | **16-0-0** | 2-0-14 | 0-0-16 | 0-0-16 | 0-0-16 | 0-0-16 | 0-0-16 | 0-0-16 | **16-0-0** | **16-0-0** | 0-0-16 | **16-0-0** | 2-0-14 | **12-0-4** | 0-0-16 | **16-0-0** | 0-0-16 | 2-12-2 | 2-12-2 | 0-0-16 | 0-0-16 | **16-0-0** | **16-0-0** | 0-0-16 | 0-0-16 | 0-0-16 | 0-0-16 | **16-0-0** | 12/36 |
| swarm | 0-0-16 | **14-0-2** | 0-0-16 | **14-0-2** | 0-0-16 | 6-0-10 | **16-0-0** | **16-0-0** | · | 0-0-16 | **14-0-2** | **16-0-0** | **12-0-4** | **16-0-0** | **16-0-0** | **16-0-0** | 0-0-16 | 0-0-16 | 0-0-16 | 0-0-16 | 0-0-16 | 0-0-16 | 0-0-16 | **14-0-2** | 0-0-16 | **14-0-2** | **16-0-0** | **16-0-0** | **14-0-2** | **14-0-2** | 0-0-16 | 0-0-16 | **14-0-2** | 8-0-8 | **16-0-0** | **16-0-0** | 0-0-16 | 19/36 |
| wallrush | **11-0-5** | **16-0-0** | 1-0-15 | 4-0-12 | **16-0-0** | 1-0-15 | 0-0-16 | 0-0-16 | **16-0-0** | · | **16-0-0** | **16-0-0** | **16-0-0** | **16-0-0** | **16-0-0** | **16-0-0** | **16-0-0** | **16-0-0** | **12-0-4** | 5-0-11 | **12-0-4** | **16-0-0** | **16-0-0** | **9-0-7** | 7-0-9 | 0-0-16 | 0-0-16 | 0-0-16 | 0-0-16 | 0-0-16 | **14-0-2** | **12-0-4** | 6-0-10 | **16-0-0** | **16-0-0** | **16-0-0** | **16-0-0** | 23/36 |
| mixed | 0-0-16 | 2-0-14 | 4-0-12 | 2-0-14 | 0-0-16 | 2-0-14 | 6-0-10 | **14-0-2** | 2-0-14 | 0-0-16 | · | 3-0-13 | 1-0-15 | **12-0-4** | **16-0-0** | **16-0-0** | 0-0-16 | 4-0-12 | 4-0-12 | 2-0-14 | 0-0-16 | 2-0-14 | 0-0-16 | 2-0-14 | 0-0-16 | 2-0-14 | **14-0-2** | **14-0-2** | 2-0-14 | 2-0-14 | 0-0-16 | 0-0-16 | 2-0-14 | 2-0-14 | **16-0-0** | **16-0-0** | 4-0-12 | 8/36 |
| quad | 0-0-16 | **13-0-3** | 0-0-16 | **16-0-0** | 0-0-16 | 6-0-10 | **16-0-0** | **16-0-0** | 0-0-16 | 0-0-16 | **13-0-3** | · | 2-0-14 | **14-0-2** | **16-0-0** | **16-0-0** | 2-0-14 | 0-0-16 | 0-0-16 | 5-0-11 | 0-0-16 | 0-0-16 | 0-0-16 | **10-0-6** | 0-0-16 | **16-0-0** | **16-0-0** | **16-0-0** | **14-0-2** | 8-0-8 | 0-0-16 | 0-0-16 | **16-0-0** | 6-0-10 | **16-0-0** | **16-0-0** | 0-0-16 | 16/36 |
| bunker | 0-0-16 | **16-0-0** | 0-0-16 | **16-0-0** | 0-0-16 | **10-4-2** | **16-0-0** | **16-0-0** | 4-0-12 | 0-0-16 | **15-0-1** | **14-0-2** | · | **10-0-6** | **16-0-0** | 2-0-14 | 2-0-14 | 2-0-14 | 2-0-14 | **13-1-2** | 0-0-16 | 8-0-8 | 0-0-16 | **14-0-2** | 0-0-16 | **16-0-0** | **16-0-0** | **16-0-0** | **16-0-0** | **14-0-2** | 0-0-16 | 0-0-16 | **16-0-0** | 6-0-10 | 0-0-16 | **14-0-2** | **10-0-6** | 19/36 |
| archers | 0-0-16 | 3-0-13 | 0-0-16 | **16-0-0** | 0-0-16 | **14-0-2** | **16-0-0** | **16-0-0** | 0-0-16 | 0-0-16 | 4-0-12 | 2-0-14 | 6-0-10 | · | **13-0-3** | 2-0-14 | 0-0-16 | 0-0-16 | 0-0-16 | **10-0-6** | 0-0-16 | 0-0-16 | 0-0-16 | **14-0-2** | 0-0-16 | **16-0-0** | **16-0-0** | **16-0-0** | **16-0-0** | **16-0-0** | 0-0-16 | 0-0-16 | **16-0-0** | **12-0-4** | 0-0-16 | **10-0-6** | 0-0-16 | 15/36 |
| runners | 0-0-16 | 0-0-16 | 0-0-16 | 2-0-14 | 0-0-16 | 2-0-14 | **14-0-2** | **16-0-0** | 0-0-16 | 0-0-16 | 0-0-16 | 0-0-16 | 0-0-16 | 3-0-13 | · | 0-0-16 | 2-0-14 | 0-0-16 | 0-0-16 | 0-0-16 | 0-0-16 | 0-0-16 | 0-0-16 | 2-0-14 | 0-0-16 | 2-0-14 | **16-0-0** | **16-0-0** | 2-0-14 | 4-0-12 | 0-0-16 | 0-0-16 | 2-0-14 | 2-0-14 | 0-0-16 | **16-0-0** | 0-0-16 | 5/36 |
| brutes | 0-0-16 | **12-0-4** | 0-0-16 | **14-0-2** | 0-0-16 | 8-0-8 | **14-0-2** | **16-0-0** | 0-0-16 | 0-0-16 | 0-0-16 | 0-0-16 | **14-0-2** | **14-0-2** | **16-0-0** | · | **14-0-2** | 0-0-16 | 0-0-16 | **10-0-6** | 0-0-16 | 0-0-16 | 0-0-16 | **12-0-4** | 0-0-16 | **14-0-2** | **16-0-0** | **16-0-0** | **14-0-2** | **14-0-2** | 0-0-16 | 0-0-16 | **14-0-2** | **14-0-2** | **16-0-0** | **16-0-0** | 0-0-16 | 19/36 |
| homeguard | 0-0-16 | **16-0-0** | 0-0-16 | **16-0-0** | 0-0-16 | **13-1-2** | **16-0-0** | **16-0-0** | **16-0-0** | 0-0-16 | **16-0-0** | **14-0-2** | **14-0-2** | **16-0-0** | **14-0-2** | 2-0-14 | · | 4-0-12 | 2-0-14 | **14-0-2** | 0-0-16 | **10-0-6** | 0-0-16 | **14-0-2** | 0-0-16 | **16-0-0** | **16-0-0** | **16-0-0** | **16-0-0** | **16-0-0** | 0-0-16 | 0-0-16 | **16-0-0** | **16-0-0** | 2-0-14 | 8-0-8 | **12-0-4** | 22/36 |
| hugetanks | 0-0-16 | 4-0-12 | 0-0-16 | 0-0-16 | 1-0-15 | 0-0-16 | 0-0-16 | 0-0-16 | **16-0-0** | 0-0-16 | **12-0-4** | **16-0-0** | **14-0-2** | **16-0-0** | **16-0-0** | **16-0-0** | **12-0-4** | · | **10-0-6** | 4-0-12 | 0-0-16 | 1-0-15 | 0-0-16 | 0-0-16 | 0-0-16 | 0-0-16 | 0-0-16 | 0-0-16 | 0-0-16 | 0-0-16 | 0-0-16 | 0-0-16 | 2-0-14 | 0-0-16 | **16-0-0** | **16-0-0** | **10-0-6** | 12/36 |
| glass | 0-0-16 | 8-0-8 | 1-0-15 | 0-0-16 | **14-0-2** | 0-0-16 | 0-0-16 | 0-0-16 | **16-0-0** | 4-0-12 | **12-0-4** | **16-0-0** | **14-0-2** | **16-0-0** | **16-0-0** | **16-0-0** | **14-0-2** | 6-0-10 | · | 0-0-16 | 0-0-16 | 4-0-12 | 1-0-15 | 0-0-16 | 1-0-15 | 0-0-16 | 0-0-16 | 0-0-16 | 0-0-16 | 0-0-16 | **13-0-3** | 5-0-11 | 1-0-15 | 4-0-12 | **16-0-0** | **16-0-0** | **16-0-0** | 13/36 |
| longbow | **14-0-2** | **14-0-2** | **16-0-0** | 2-4-10 | **13-0-3** | 2-0-14 | **14-0-2** | **16-0-0** | **16-0-0** | **11-0-5** | **14-0-2** | **11-0-5** | 2-1-13 | 6-0-10 | **16-0-0** | 6-0-10 | 2-0-14 | **12-0-4** | **16-0-0** | · | 4-0-12 | **14-0-2** | **16-0-0** | 2-4-10 | **16-0-0** | 2-0-14 | **16-0-0** | **16-0-0** | 2-10-4 | 6-0-10 | **16-0-0** | **14-0-2** | 2-0-14 | 4-0-12 | 8-0-8 | **16-0-0** | **16-0-0** | 22/36 |
| scoutsFilled | 5-0-11 | **12-0-4** | 2-0-14 | 4-0-12 | **16-0-0** | **16-0-0** | 0-0-16 | 0-0-16 | **16-0-0** | 4-0-12 | **16-0-0** | **16-0-0** | **16-0-0** | **16-0-0** | **16-0-0** | **16-0-0** | **16-0-0** | **16-0-0** | **16-0-0** | **12-0-4** | · | 7-0-9 | 7-0-9 | **11-0-5** | 3-0-13 | 0-0-16 | 0-0-16 | 0-0-16 | 0-0-16 | 0-0-16 | 5-0-11 | 6-0-10 | 6-0-10 | **11-0-5** | **16-0-0** | **16-0-0** | **16-0-0** | 19/36 |
| firesquad | 0-0-16 | **7-7-2** | 0-0-16 | 2-0-14 | **10-0-6** | 2-0-14 | 6-0-10 | **14-0-2** | **16-0-0** | 0-0-16 | **14-0-2** | **16-0-0** | 8-0-8 | **16-0-0** | **16-0-0** | **16-0-0** | 6-0-10 | **15-0-1** | **12-0-4** | 2-0-14 | **9-0-7** | · | 0-0-16 | 2-0-14 | 0-0-16 | 2-0-14 | **14-0-2** | **14-0-2** | 4-0-12 | 2-0-14 | 5-0-11 | 2-0-14 | 2-0-14 | 4-0-12 | **16-0-0** | **16-0-0** | **16-0-0** | 17/36 |
| shatter | **12-0-4** | **16-0-0** | 2-0-14 | 2-0-14 | **16-0-0** | 0-0-16 | 4-0-12 | 4-0-12 | **16-0-0** | 0-0-16 | **16-0-0** | **16-0-0** | **16-0-0** | **16-0-0** | **16-0-0** | **16-0-0** | **16-0-0** | **16-0-0** | **15-0-1** | 0-0-16 | **9-0-7** | **16-0-0** | · | **10-0-6** | 2-0-14 | 0-0-16 | 0-0-16 | 8-0-8 | 0-0-16 | **16-0-0** | **16-0-0** | 4-0-12 | 6-0-10 | **16-0-0** | **16-0-0** | **16-0-0** | **16-0-0** | 22/36 |
| frostnest | **11-0-5** | **14-0-2** | **11-0-5** | **6-8-2** | **11-0-5** | 6-4-6 | **14-0-2** | **16-0-0** | 2-0-14 | 7-0-9 | **14-0-2** | 6-0-10 | 2-0-14 | 2-0-14 | **14-0-2** | 4-0-12 | 2-0-14 | **16-0-0** | **16-0-0** | **10-4-2** | 5-0-11 | **14-0-2** | 6-0-10 | · | 3-0-13 | **6-8-2** | **16-0-0** | **16-0-0** | **12-2-2** | 6-0-10 | **16-0-0** | 6-0-10 | **10-4-2** | 2-0-14 | 2-0-14 | 2-0-14 | **16-0-0** | 20/36 |
| storm | 2-0-14 | **15-0-1** | 1-0-15 | 4-0-12 | **16-0-0** | 0-0-16 | 0-0-16 | 0-0-16 | **16-0-0** | **9-0-7** | **16-0-0** | **16-0-0** | **16-0-0** | **16-0-0** | **16-0-0** | **16-0-0** | **16-0-0** | **16-0-0** | **15-0-1** | 0-0-16 | **13-0-3** | **16-0-0** | **14-0-2** | **13-0-3** | · | 0-0-16 | 0-0-16 | 0-0-16 | 0-0-16 | 0-0-16 | **14-0-2** | 8-0-8 | 6-0-10 | **16-0-0** | **16-0-0** | **16-0-0** | **16-0-0** | 22/36 |
| mortars | 0-0-16 | **14-0-2** | **16-0-0** | 2-12-2 | **16-0-0** | 2-12-2 | **14-0-2** | **16-0-0** | 2-0-14 | **16-0-0** | **14-0-2** | 0-0-16 | 0-0-16 | 0-0-16 | **14-0-2** | 2-0-14 | 0-0-16 | **16-0-0** | **16-0-0** | **14-0-2** | **16-0-0** | **14-0-2** | **16-0-0** | 2-8-6 | **16-0-0** | · | **16-0-0** | **16-0-0** | **10-4-2** | **10-0-6** | **16-0-0** | **16-0-0** | 2-12-2 | 6-0-10 | 0-0-16 | 2-0-14 | **16-0-0** | 22/36 |
| firenest | **16-0-0** | 2-0-14 | **16-0-0** | 0-0-16 | **16-0-0** | 0-0-16 | 2-0-14 | 2-12-2 | 0-0-16 | **16-0-0** | 2-0-14 | 0-0-16 | 0-0-16 | 0-0-16 | 0-0-16 | 0-0-16 | 0-0-16 | **16-0-0** | **16-0-0** | 0-0-16 | **16-0-0** | 2-0-14 | **16-0-0** | 0-0-16 | **16-0-0** | 0-0-16 | · | 2-12-2 | 0-0-16 | 0-0-16 | **16-0-0** | **16-0-0** | 0-0-16 | 0-0-16 | 0-0-16 | 0-0-16 | **16-0-0** | 12/36 |
| icewall | **16-0-0** | 2-0-14 | **16-0-0** | 0-0-16 | **16-0-0** | 0-0-16 | 2-0-14 | 2-12-2 | 0-0-16 | **16-0-0** | 2-0-14 | 0-0-16 | 0-0-16 | 0-0-16 | 0-0-16 | 0-0-16 | 0-0-16 | **16-0-0** | **16-0-0** | 0-0-16 | **16-0-0** | 2-0-14 | 8-0-8 | 0-0-16 | **16-0-0** | 0-0-16 | 2-12-2 | · | 0-0-16 | 0-0-16 | **16-0-0** | **16-0-0** | 0-0-16 | 0-0-16 | 0-0-16 | 0-0-16 | **16-0-0** | 11/36 |
| bombard | 0-0-16 | **14-0-2** | **16-0-0** | 2-4-10 | **16-0-0** | 2-4-10 | **14-0-2** | **16-0-0** | 2-0-14 | **16-0-0** | **14-0-2** | 2-0-14 | 0-0-16 | 0-0-16 | **14-0-2** | 2-0-14 | 0-0-16 | **16-0-0** | **16-0-0** | **4-10-2** | **16-0-0** | **12-0-4** | **16-0-0** | 2-2-12 | **16-0-0** | 2-4-10 | **16-0-0** | **16-0-0** | · | 8-0-8 | **14-0-2** | **16-0-0** | 2-4-10 | 2-0-14 | 0-0-16 | 2-0-14 | **16-0-0** | 20/36 |
| blizzard | **13-0-3** | **14-0-2** | 8-0-8 | **10-0-6** | **16-0-0** | 6-0-10 | **14-0-2** | **16-0-0** | 2-0-14 | **16-0-0** | **14-0-2** | 8-0-8 | 2-0-14 | 0-0-16 | **12-0-4** | 2-0-14 | 0-0-16 | **16-0-0** | **16-0-0** | **10-0-6** | **16-0-0** | **14-0-2** | 0-0-16 | **10-0-6** | **16-0-0** | 6-0-10 | **16-0-0** | **16-0-0** | 8-0-8 | · | 2-0-14 | **16-0-0** | **10-0-6** | **10-0-6** | 0-0-16 | 2-0-14 | **16-0-0** | 22/36 |
| healerball | 0-0-16 | **15-0-1** | 0-0-16 | 0-0-16 | **15-0-1** | 0-0-16 | 0-0-16 | 0-0-16 | **16-0-0** | 2-0-14 | **16-0-0** | **16-0-0** | **16-0-0** | **16-0-0** | **16-0-0** | **16-0-0** | **16-0-0** | **16-0-0** | 3-0-13 | 0-0-16 | **11-0-5** | **11-0-5** | 0-0-16 | 0-0-16 | 2-0-14 | 0-0-16 | 0-0-16 | 0-0-16 | 2-0-14 | **14-0-2** | · | 0-0-16 | 6-0-10 | **15-0-1** | **16-0-0** | **16-0-0** | **16-0-0** | 18/36 |
| buffedrush | 7-0-9 | **15-0-1** | 2-0-14 | 4-0-12 | **14-0-2** | 0-0-16 | 0-0-16 | 0-0-16 | **16-0-0** | 4-0-12 | **16-0-0** | **16-0-0** | **16-0-0** | **16-0-0** | **16-0-0** | **16-0-0** | **16-0-0** | **16-0-0** | **11-0-5** | 2-0-14 | **10-0-6** | **14-0-2** | **12-0-4** | **10-0-6** | 8-0-8 | 0-0-16 | 0-0-16 | 0-0-16 | 0-0-16 | 0-0-16 | **16-0-0** | · | **10-0-6** | **14-0-2** | **16-0-0** | **16-0-0** | **16-0-0** | 22/36 |
| shieldwall | 2-0-14 | **14-0-2** | **10-0-6** | 2-12-2 | **16-0-0** | 2-8-6 | **14-0-2** | **16-0-0** | 2-0-14 | **10-0-6** | **14-0-2** | 0-0-16 | 0-0-16 | 0-0-16 | **14-0-2** | 2-0-14 | 0-0-16 | **14-0-2** | **15-0-1** | **14-0-2** | **10-0-6** | **14-0-2** | **10-0-6** | 2-4-10 | **10-0-6** | 2-12-2 | **16-0-0** | **16-0-0** | **10-4-2** | 6-0-10 | **10-0-6** | 6-0-10 | · | 2-0-14 | 0-0-16 | 2-0-14 | **16-0-0** | 20/36 |
| bigFriends | 0-0-16 | **14-0-2** | 2-0-14 | **10-0-6** | **11-0-5** | **10-0-6** | **14-0-2** | **16-0-0** | 8-0-8 | 0-0-16 | **14-0-2** | **10-0-6** | **10-0-6** | 4-0-12 | **14-0-2** | 2-0-14 | 0-0-16 | **16-0-0** | **12-0-4** | **12-0-4** | 5-0-11 | **12-0-4** | 0-0-16 | **14-0-2** | 0-0-16 | **10-0-6** | **16-0-0** | **16-0-0** | **14-0-2** | 6-0-10 | 1-0-15 | 2-0-14 | **14-0-2** | · | 2-0-14 | 4-0-12 | **16-0-0** | 21/36 |
| elemfactories | 0-0-16 | 0-0-16 | 0-0-16 | **16-0-0** | 0-0-16 | **10-0-6** | **16-0-0** | **16-0-0** | 0-0-16 | 0-0-16 | 0-0-16 | 0-0-16 | **16-0-0** | **16-0-0** | **16-0-0** | 0-0-16 | **14-0-2** | 0-0-16 | 0-0-16 | 8-0-8 | 0-0-16 | 0-0-16 | 0-0-16 | **14-0-2** | 0-0-16 | **16-0-0** | **16-0-0** | **16-0-0** | **16-0-0** | **16-0-0** | 0-0-16 | 0-0-16 | **16-0-0** | **14-0-2** | · | **16-0-0** | 0-0-16 | 17/36 |
| stormrunners | 0-0-16 | 0-0-16 | 0-0-16 | **14-0-2** | 0-0-16 | 6-0-10 | **14-0-2** | **16-0-0** | 0-0-16 | 0-0-16 | 0-0-16 | 0-0-16 | 2-0-14 | 6-0-10 | 0-0-16 | 0-0-16 | 8-0-8 | 0-0-16 | 0-0-16 | 0-0-16 | 0-0-16 | 0-0-16 | 0-0-16 | **14-0-2** | 0-0-16 | **14-0-2** | **16-0-0** | **16-0-0** | **14-0-2** | **14-0-2** | 0-0-16 | 0-0-16 | **14-0-2** | **12-0-4** | 0-0-16 | · | 0-0-16 | 11/36 |
| medictent | 0-0-16 | 4-0-12 | 0-0-16 | 0-0-16 | 0-0-16 | 0-0-16 | 0-0-16 | 0-0-16 | **16-0-0** | 0-0-16 | **12-0-4** | **16-0-0** | 6-0-10 | **16-0-0** | **16-0-0** | **16-0-0** | 4-0-12 | 6-0-10 | 0-0-16 | 0-0-16 | 0-0-16 | 0-0-16 | 0-0-16 | 0-0-16 | 0-0-16 | 0-0-16 | 0-0-16 | 0-0-16 | 0-0-16 | 0-0-16 | 0-0-16 | 0-0-16 | 0-0-16 | 0-0-16 | **16-0-0** | **16-0-0** | · | 8/36 |

</details>

### Stated outcomes

| A | B | A vs B (W-D-L) |
|---|---|---|
| shatter | bricks | 12-0-4 |
| shatter | bigFriends | 16-0-0 |
| frostnest | bricks | 11-0-5 |
| blizzard | bricks | 13-0-3 |
| blizzard | buffedrush | 16-0-0 |
| mortars | scoutsFilled | 16-0-0 |
| storm | scoutsFilled | 13-0-3 |
| storm | runners | 16-0-0 |
| firenest | storm | 16-0-0 |
| icewall | wallrush | 16-0-0 |
| healerball | templates | 15-0-1 |
| shatter | healerball | 16-0-0 |
| firenest | healerball | 16-0-0 |
| firesquad | healerball | 5-0-11 |
| buffedrush | templates | 15-0-1 |
| buffedrush | shatter | 12-0-4 |
| buffedrush | turtle | 4-0-12 |
| buffedrush | longbow | 2-0-14 |
| shieldwall | glass | 15-0-1 |
| bigFriends | tanks | 2-0-14 |
| bigFriends | bombard | 14-0-2 |
| bigFriends | longbow | 12-0-4 |
| elemfactories | runners | 16-0-0 |
| medictent | mixed | 12-0-4 |

Asserted (≥ 9 of 16, ≥ 5 of 8 on one seed): shatter > bricks and Huge Tank + friends; frost
nest > bricks; blizzard > bricks and buffed rush; mortars > padded scouts; storm > padded
scouts or runners; fire splash nest > storm; ice wall > walls + rush; healer ball >
templates; shatter and fire splash nest > healer ball; buffed rush > templates and shatter;
shield wall > glass; Huge Tank + friends > bombard and longbow; elemental factories >
runners; medic tent > mixed. Re-recorded from the spec's guesses, which don't hold on the
routing engine: the fire squad loses to the healer ball (5-11; its 2 towers stay home), but
fire is still the healer counter (the same squad made normal goes 0-16, and the shatter
squad and the fire splash nest win 16-0); the buffed rush loses to the turtle (4-12) and the
longbow (2-14) but beats templates and the shatter squad; Huge Tank + friends loses to the
4 Half Tanks (2-14) but walks through the bombard and the longbow. The six's old shape
"tanks beat bricks" reversed with 4 tanks instead of 5 (bricks 12-4); the snipers beat the
bricks (10-6).

### No element dominates per dollar

| element army | its round robin | normal twin | twin's round robin (same field) | head to head (W-D-L) |
|---|---|---|---|---|
| firesquad ($4977) | 286/576 (50%) | fire squad made normal (5 Basic Soldiers, 2 Basic Towers) ($4553) | 231/576 (40%) | 12-2-2 |
| shatter ($4641) | 366/576 (64%) | shatter squad without ice (5 Fire Soldiers, 2 Archers, 1 Basic Soldier) ($4926) | 406/576 (70%) | 0-0-16 |
| storm ($4445) | 354/576 (61%) | storm crowd made normal (9 Basic Soldiers) ($4761) | 473/576 (82%) | 0-0-16 |
| frostnest ($4623) | 322/576 (56%) | frost nest made normal (2 Basic Soldiers holding by 2 Basic Towers and 1 Sniper Tower) ($4471) | 357/576 (62%) | 2-12-2 |

The spec's form (each element army 35-65% head to head against its twin) can't hold with
whole Basic Soldiers: the twin is the same army made normal with the leftover money spent on
soldiers, so it has $400 less (fire squad: 12-2-2 for the fire squad) or one body more (storm,
shatter: 0-16 for the twin) and the deterministic bots decide almost every battle the same
way. The test compares each element army's round robin with its twin's over the same field
instead: at most +12 points (fire squad +10, frost nest −6, shatter −6, storm −21). Bodies
matter more than zaps in a soldier blob, so lightning pays off against clumps of enemies,
not as a blob of its own.

### Effects, combos and heal limits

| archetype | burn damage | shatters | zaps | overload zaps | HP healed | cleanses |
|---|---|---|---|---|---|---|
| firesquad | 220,370 | 0 | 0 | 0 | 0 | 0 |
| shatter | 197,718 | 8007 | 0 | 0 | 0 | 0 |
| storm | 0 | 0 | 6831 | 0 | 0 | 0 |
| firenest | 164,389 | 0 | 0 | 0 | 0 | 0 |
| bombard | 173,677 | 0 | 0 | 0 | 0 | 0 |
| blizzard | 145,755 | 8489 | 0 | 0 | 0 | 0 |
| healerball | 0 | 0 | 0 | 0 | 498,029 | 1586 |
| bigFriends | 0 | 0 | 0 | 0 | 278,019 | 387 |
| elemfactories | 37,896 | 684 | 0 | 0 | 0 | 0 |
| stormrunners | 0 | 0 | 1124 | 0 | 0 | 0 |
| medictent | 0 | 0 | 0 | 0 | 78,110 | 34 |

- 1053 battles with heals: the most any body got in one 60-tick window is 5.00% of its max HP (cap 5%); the last heal lands in the frame at t = 2996 (sudden death from 3000).
- Healer ball against healer ball always ends with a death before the timeout (8 of 8: both sites, both zone pairs, both seeds).
- Overload zaps (lightning on a burning target) need fire and lightning on the same enemy:
  no archetype has both, so they only happen in team games. Shatters: 8,007 by the shatter
  squad, 8,489 by blizzard + fire, 684 by the elemental factories (ice archers + fire brutes);
  both combo armies stay under the cap (64% and 61%).
- A side of damage-0 units only (2 medics, 2 drummers, 2 banners) is eliminated at tick 0;
  lightning battles give identical frames with the placements in reverse order.

### Watch items

- **Soldier spam (open item 10, analysed below in "The template rush").** The 9-soldier rush
  ($4,761) wins **83%** (489/592) against the 37; 5 soldiers + 2 towers wins 39% (233/592).
  Neither is in the round robin yet: the fix is a design decision (see below).
- **Bricks** 71% (capped key). **Runners** 18%, **medic tent** 25%, **mixed** 29%: weak
  but each beats someone.
- **Performance:** the M8.8 timing case (Ring 8, 8 players with lightning splash 80,
  fire, medics, a drummer, 2 Storm Runner factories, 12 maze walls each) runs at p99 5.7 ms
  per tick with 127 events/s (target p99 < 8 ms, ≤ 600 events/s); the M8.5 worst case 7.4 ms,
  M8.6 kinds 5.7 ms, M8.7 maze 6.3 ms on the same (loaded) machine. See "Timing pass: what a
  tick spends" below for the flaky runs.

### The template rush (open item 10, measured 2026-10-24)

**Why 9 Basic Soldiers win 83%.** Measured on the default config, both seeds unless noted
(`scripts/balance-matrix.ts` prints the two plain template armies against the field):

- **Value per dollar.** A melee army's strength is about (Σ HP) × (Σ DPS) (Lanchester), so a
  unit is worth about √(HP × DPS) per dollar. The Basic Soldier is the best buy in the game:
  0.327 (√(600 × 50) / $529), against 0.315 for the Half Tank, 0.273 for the brick (power
  ×1.37), 0.262 for the Basic Tower (it pays ×1.33 on its whole body for attacking every 0.75 s)
  and 0.19 for the Sniper Tower. Its stats sit low on every curve (+5% curve, power ×1.02), and
  the only per-body charge is the $50 Base, under 10% of its price.
- **Bodies.** $5,000 buys 9 of them, and strength grows with the square of the bodies: 7
  lightning soldiers (the storm crowd) win 61%, 8 plain soldiers 67% (396/592), 9 win 83%.
  The 9th soldier alone is worth 16 points.
- **Only numbers-counters beat it.** It loses only to splash (mortars, bombard), walls (the
  sealed fortress, the walled nests) and nothing else: 16-0 against the bricks, the tanks, the
  storm crowd, the shatter squad.
- **Not the causes:** the k = 1 curve (at k = 2 the soldier would cost $554, still 9 per
  army); the tower's range (Basic Towers of range 150-180, priced to the same $920-960, leave
  the rush at 83.6%, one seed).

**Why config alone can't fix it without breaking a stated outcome.** Every price change that
leaves 8 soldiers (the soldier at $556 or more) also drops a soldier from walls + rush, the
factory swarm and the brute breakers, and the turtle-vs-rush stated outcome then fails: 5
Basic Towers beat 8 plain soldiers 14-2. Tried, all on the routing engine with the archetypes
refit by the M8.8 rules (one seed unless noted):

| change | rush | what breaks |
|---|---|---|
| 8 soldiers, nothing else (forced) | 67% (2 seeds) | the turtle beats the rush 14-2 |
| `cost.base` 76-80 (+ a cheaper Basic Tower so 4 + 3 fit) | 74-75% | bricks 80% (the per-body tax helps two big bodies), scouts drop to 10 |
| `cost.speed` 80-82, `cost.hp` 0.343 | 71-74% | bricks 72-80%, the turtle wins or tanks pass 70% |
| a weaker Basic Soldier, 9 still fit (500-550 HP, speed 2-2.2) | 61-77% | bricks 77-78% (their prey gets weaker), templates 22% |
| Basic Soldier speed 1.8 ($556) + Basic Tower 565 HP ($921) | 75% | bricks 73% in the 17 |
| soldier 600 / 52 dmg / range 41 / size 12 ($557), tower 565 HP, walls + rush keeps 8 soldiers (3 walls) | 67% (2 seeds) | the 39-matrix holds, but tanks 73% in the 17, Lanes rush vs turtle, two free-for-all caps, Huge Tank + friends vs longbow 8-8 |
| `cost.powerFactor` 0.9 (bricks 1,600 / 255), soldier 575 / 52 / 42 / size 12 ($556), tower 540 HP ($922) | 68% (2 seeds) | every archetype ≤ 70% in the 39-matrix, but the six's shape (tanks beat the turtle), a 13-matrix shape check, tanks 74% in the 17, Lanes rush vs turtle, the building free-for-all cap |

The common thread: for the rush to beat the turtle with 8 soldiers the Basic Tower has to get
weaker, and then the tanks beat the turtle too and pass 70%; and every rush fix takes wins away
from the soldier armies that keep the bricks under their cap. **Decision needed** (plan §17 item
10): (a) re-record "the rush beats the turtle" as "5 towers hold 8 plain soldiers; speed, splash
or walls break a turtle" and price the soldier to 8 per army, or (b) accept the 83% rush and
teach the counters (splash, walls, "spread out"), or (c) a bigger template/budget redesign.

### Lanes and free-for-alls

- 2-team Lanes 8 with element and support armies (3 line-ups × 2 rounds × 2 seeds): contact
  within 2 s every time, every battle decided by fighters; the element team wins the shatter +
  mortars + buffed rush + medic tent line-up in round 0 and loses the rest. Heal limits hold.
- Ring 8 free-for-all, element armies (storm, shatter, mortars, healer ball, blizzard, fire
  splash nest, buffed rush, Huge Tank + friends): blizzard 6, mortars 5, healer ball 4, fire
  splash nest 1 of 16.
- The older free-for-alls: the six turtle 12, snipers 8 (the turtle's free-for-all cap re-recorded 14 → 12 of 16); building
  armies fortress 8, swarm 6, bunker 2; minion kinds home guard 8, brutes 7, swarm 1, quad 1.
- Turtle vs rush: the rush wins 14 of 16 duels and every Lanes battle; the rush beats the
  open U fortress 16-0 and loses to the sealed one 0-16; brutes break the sealed fortress 14-2.

### Timing pass: what a tick spends (2026-10-24)

`tests/buildings-perf.test.ts` failed 4 of 9 full runs (p99 8.3-12.9 ms against the 8 ms
target). Profiled per tick (engine work, the wait for the 8 sandbox processes, the time inside
the slowest sandbox, GC), quiet 10-core box:

| case | tick p50 / p99 / max | engine's own work p99 | sandbox wait p99 / max | inside the slowest sandbox p99 | main-process GC |
|---|---|---|---|---|---|
| M8.5 buildings worst case | 2.26 / 6.05 / 14.2 ms | 0.93 ms | 5.49 / 13.4 ms | 3.35 ms | 88 pauses, max 3.4 ms |
| M8.8 elements and support | 2.21 / 6.28 / 16.5 ms | 0.81 ms | 5.57 / 9.2 ms | 3.05 ms | 86 pauses, max 2.5 ms |

The engine is not the problem: its own work is p99 under 1 ms (only tick 0, with the first
flow fields and a cold JIT, takes 7-9 ms). The worst ticks are all waits for the sandboxes:
the tick waits for the slowest of 8 child processes, so the OS scheduling them (and IPC, and a
sandbox's own GC) sets the tail, and any other load on the machine lands there. With 6 busy
processes running beside it, the same case measures p99 15-18 ms while the engine's share stays
1.1-1.4 ms.

So the test now measures both, on the unchanged 8 ms target: the engine's own work
(`BattleEngine.tickWaitMs` is recorded per tick; tick minus wait) must have p99 < 4 ms in the
run, and the whole tick p99 < 8 ms as the best of up to 3 runs. Host noise only ever adds time,
so one noisy run is retried, while a real regression (engine or sandbox side) fails all three.
Quiet box: p99 6.2-6.5 ms in one run each, engine 0.6-1.0 ms. For the event Mac: run
`npm run test:perf` with nothing else open; a sustained p99 over 8 ms there means the knobs of
§15 (`caps.maxCopies`, `caps.maxWallCopies`, `factory.maxAlivePerBattle`).

### Bots (`npm run bots`, M8.8)

Five new strategies (all in `mixed`): `elements` (Pyro fire soldiers that hit frozen enemies
first, Frostbow ice archers, a Frost Tower), `storm` (Stormling lightning soldiers, a Mortar
that splashes the biggest clump, Brawlers), `splash` (Mortars behind a wall line), `support`
(a Medic that cleanses then heals, a War Drummer, a Shield Bearer) and `medics` (a Medic Tent
guarding the toughest soldier, a Fire Grunts factory, Brawlers). Every design validates with
no warnings ($603-$1,292).

## Fast balance runs (tooling, 2026-10-24)

A balance investigation used to cost about 4 minutes per round robin ($10,000
economy, 39 archetypes) and 99 s for the balance test file. Three things make
re-runs and config experiments much cheaper. None of them changes the sim or
the config.

**1. The lean runner, checked against the real sandbox.** The round robins already
played the archetype brains as plain functions in the worker processes (the
`BrainRunner`, no isolate and no IPC). The brains now live in a
self-contained `tests/helpers/brains.ts`. `tests/helpers/brainUnits.ts` turns that
same file into unit code: the validator's transpile plus a unit class whose
`update()` calls the brain. So the same code also runs on the real runners:
isolated-vm in a child process, the server default, and node:vm (`inproc-unsafe`).
`balanceBattle(..., runner)` takes `'lean' | 'vm' | 'ivm'`.

`tests/balance-parity.test.ts` runs in the balance pass. It plays 15 matchups on
all three runners, with every brain covered: chase, hold, towers, medics and
auras, focus fire (soldiers, hold soldiers, towers), backline divers (dive, flank,
the factories' dive raid), all six factory orders plus hold, walls, elements and splash, on both maps
and both seeds. Every frame must hash the same, and the result must be identical.
It is. Per battle, the lean runner is about 10× faster than node:vm and about 14×
faster than isolated-vm (5 battles: 0.22 s, 2.3 s and 3.1 s). Caveats:
- The sandbox runs use generous limits (`BALANCE_SANDBOX_LIMITS`). With the real
  6/12 ms limits, a loaded machine could hand out slow strikes. Those come from
  the host, not the code.
- The lean runner passes each unit the ally list with itself in it. The harness
  leaves it out. No brain looks at itself among its allies, and the parity test
  holds that.

**2. The result cache** (`tests/helpers/balanceCache.ts`, `.balance-cache/`,
gitignored). Battles are deterministic, so every round-robin duel and every
`balanceBattle` result is kept on disk. The key has four parts:
- **Engine hash:** the files under `packages/server/src/sim`, `packages/server/src/sandbox`
  and `packages/shared/src`, plus the transpile step, the balance harness, the brains,
  the V8 version and the CPU architecture.
- **Config fields that battle can read** (relevance-aware since 2026-10-25, see
  [Sweeps](#sweeps-and-the-relevance-aware-cache-2026-10-25)): every config leaf is
  classified in `CONFIG_LEAF_RULES` as global (every battle), unread (caps, plan
  timers, match size, rate limits, prices) or conditional on what the two armies
  field (factories, support, each element, any element, splash). The key hashes the
  global fields plus the conditional ones the armies make readable. Prices count
  only through each army's priced designs and the minion values. So a price only
  factories pay, or a factory-only knob, replays only the battles with factories.
- **Both armies as deployed:** designs, costs, placements and brains.
- **The battle itself:** map, zone pair, seed and runner.

Any edit to an engine file starts a fresh cache, and the six newest engine
versions are kept. `BALANCE_CACHE=0` turns the cache off, and
`BALANCE_CACHE_DIR` moves it. The balance test uses the cache too and asserts
the same rules on the cached records. Run it with `BALANCE_CACHE=0` to replay
everything. The `ms` engine times of a cached battle are from its first run.

**3. Early stopping** (`tests/helpers/balanceFast.ts`, rules in
`tests/helpers/balanceRules.ts`). The rules are the balance test's round-robin rules:
- the 70% cap and the recorded bricks exceptions;
- beats someone, doesn't beat everyone, loses to someone (on the 6, 13, 17 and 37 matrices);
- the shape checks and the stated outcomes.

A matchup is a fixed set of 8 battles (16 with both seeds), so after k of them
the rest can only move the counts so far. Each rule is decided as soon as it
can't change. Battles are played only for the matchups some open rule still
depends on: 2 per matchup up front, then 2 more per round. Each matchup plays in
a spread order, so both maps and both zone pairs come first.
- `--exact`: decided only when no outcome of the unplayed battles can change the
  rule. This gives the full matrix's verdicts by construction, and
  `tests/balance-fast.test.ts` checks it on 40 random matrices. It saves little
  here (87% of the battles), because 8 archetypes sit at 60-70% and only the
  last battles decide their caps.
- `--fast`: also decided when the rule holds (or fails) with probability
  ≥ 1 − alpha. Alpha defaults to 0.001. The model is a Jeffreys-prior Dirichlet
  model of each matchup: exact odds for one matchup, a normal approximation for
  a row's total wins. It is a heuristic, because the battles of a matchup are
  not random draws. So it was checked with `--verify`, which plays the full
  matrix too and compares every verdict. It was run on the committed config and
  eight patched configs, six of which fail 1 to 30 rules:
  - fire ×2 / shatter 150%;
  - no ice;
  - splash 100%;
  - sudden death 1%/s;
  - heal room 15%/s;
  - lightning 80%;
  - ice 70% for 4 s;
  - sudden death 20%/s from 30 s.

  **Same verdict on all 326 rules in all nine configs**, using 45% of the battles
  overall (36.5% on the committed config, 23% with both seeds). Priors 0.25-1 and
  alpha 0.01-0.0001 also gave no difference (41-51% of the battles). An earlier
  three-outcome win model was biased against lopsided matchups and got two caps
  wrong on the weak sudden-death config. That is why every new model has to pass
  the `--verify` sweep.

The battle-level checks (no wall-only wins, the heal limits) only see the
battles that were played. The balance test still checks every battle.

### Timings (37 archetypes, committed config, quiet 10-core box)

| run | before | after |
|---|---|---|
| balance test file (`PIXEL_CLASH_PERF=balance vitest run tests/balance.test.ts`) | 99 s | cold 92 s, **warm 0.7 s** |
| full matrix, both seeds (10,656 battles) | 103 s (8 workers, fixed shards) | cold 99-106 s (9 workers, one battle at a time), **warm 0.4 s** |
| full matrix, seed 11 (5,328 battles) | about 50 s | cold: `--full` 42-50 s, `--exact` 46 s (87%), **`--fast` 22 s (42%)**; warm under 1 s |
| both seeds, `--fast`, cold | | **32 s** (27% of the battles) |

Cold full runs are no faster: the engine is the work (about 28 µs per tick, so
779 s of CPU for the 2-seed matrix), and the lean runner was already in use.
The gains come from:
- never replaying a battle (the cache, which also covers re-runs after a config
  change that leaves some battles alone);
- not playing battles that can't change a verdict (early stopping, 3-4× fewer).

For the $10,000 retune, that is about 4 minutes per round robin cold →
about 1.5 minutes with `--fast` (estimated from the battle share), and seconds for
anything already played.

### Usage

```
npm run balance                                   # exact early stopping, the test's seed (8 battles per pair)
npm run balance -- --fast                         # statistical early stopping (the quick one)
npm run balance -- --fast --config patch.json     # try a config patch (file or inline JSON)
npm run balance -- --fast --config '{"elements":{"splashPct":60}}'
npm run balance -- --archetypes bricks,tanks,turtle,scouts,snipers,templates
npm run balance -- --seeds 11,4242                # 16 battles per pair (what this file records)
npm run balance -- --full --runner ivm            # confirmation pass on the real sandbox (slow, about 14×)
npm run balance -- --fast --verify                # also play the full matrix and diff the verdicts
npm run balance -- --all --top 15 --json out.json --no-cache --workers 10 --alpha 0.001
```

The CLI prints:
- the overall rates (an estimate with [lowest, highest] possible while battles are unplayed);
- every stated outcome and shape check with its W-D-L;
- the caps and structure verdicts;
- the battles needed, played and cached.

It exits 1 when a rule fails. A config patch is checked by the config schema.
Archetypes and their rules come from `tests/helpers/balance.ts` and
`tests/helpers/balanceRules.ts`. A matrix rule applies only when all of its
archetypes are in the run, and a custom `--archetypes` selection gets its own
70% / structure rules. The twins, free-for-all, Lanes and turtle-vs-rush checks
stay in the test.

### Sweeps and the relevance-aware cache (2026-10-25)

The user asked (verbatim): "Is there a way to make this more efficient?" about the
~6.5 minutes each `--full` point of the radius sweep took. Two changes, tooling only:

**1. The cache keys each battle on only the config fields it can read** (commit
a443e88, `CONFIG_LEAF_RULES` in `tests/helpers/balanceCache.ts`; the key bullet above).
A factory knob re-plays only the battles where an army has a factory (about 45% of the
duels), a heal knob only those with support, an element knob only those with that
element. Every config leaf has a rule; `tests/balance-fast.test.ts` fails on an
unclassified leaf (it covers `factory.dieAtSuddenDeath` through the `factory` rule).

**2. `npm run balance:sweep`** (`scripts/balance-sweep.ts`): one knob at several values.
For each value it runs `npm run balance -- --fast` on the whole pool (refit to the patch,
every rule checked), then prints one table: each archetype's rate per value (the extras
and the archetypes the knob reaches first, then the biggest movers), rules
pass/fail/open, battles played and cached, seconds, and every failing rule per value.
It picks the best value (every rule passes and closest to `--target`, else the fewest
failures) and prints the `--full` command to confirm it; `--confirm` runs it.

```
npm run balance:sweep -- --param factory.crumbleRadius=120,200 \
  --with '{"factory":{"minionsDieWithFactory":true}}' --seeds 11,4242 \
  --extra camp,camptowers,campfive --target camp<=60% --confirm
npm run balance -- --fast --extra camp,camptowers    # the camps against the pool in one run
```

`--extra a,b` (also on `npm run balance`) plays archetypes outside the round robin (the
camps) against the pool, every battle, draws half, reported only.

**Measured** (default workers on a 10-core machine, seeds 11 and 4242, 51 archetypes + 3 camps):

| run | battles played / cached | wall time |
|---|---|---|
| `--full`, fresh engine (the old way, every point) | 19,782 / 3,066 | 421 s |
| `--full`, a factory knob changed (dieAtSuddenDeath off) | 11,600 / 11,248 | 401 s* |
| sweep point `--fast`, new factory value (crumbleRadius 120) | 5,446 / 5,076 | 196 s |
| sweep point `--fast`, new factory value (crumbleRadius 200) | 5,446 / 5,076 | 314 s |
| `--confirm` `--full` after its `--fast` point | 6,154 / 16,694 | 193 s |
| sweep, both points already played (dieAtSuddenDeath true,false) | 0 / 14,396 | 4 s |

\* the cached duels were cheap ones; the factory battles are the long ones (minions,
sudden death), so a factory knob saves battles more than time. So a cold factory point
costs about 3-5 minutes with `--fast` instead of ~7 with `--full`, the confirmation of the
chosen value about 3 minutes more, and any value already played costs seconds.

**Workflow:** explore with `balance:sweep` (or `npm run balance -- --fast --config …`)
on the whole pool, then **confirm the one chosen value once with `--full`** (or
`--confirm`). Do not decide on `--fast` alone: on the "Factories die at sudden death"
default, `--fast --verify` passed splashline and guardedcatapults ≤ 70% where the full
matrix fails them (75.6%, 71.8%), the first `--verify` difference seen. The sweep's
`--fast` estimates (wins / battles played) also differ from the full rates by several
points, so compare verdicts and camp columns between points, and quote full numbers.

## Exploit search (`npm run balance:exploit`, 2026-10-24)

`scripts/balance-exploit.ts` runs an evolutionary search over whole armies a
player could submit:
- up to 4 soldier designs and 4 tower designs;
- each design picks HP, damage, range, speed, cooldown, size, element and splash,
  plus its copies and the hold-by-the-tower brain (and, since 2026-10-24, focus fire
  for the army and the dive or flank brain per soldier design);
- every design passes the shared `checkStats` bounds and is priced by
  `computeCost`, and the army fits the budget, unit cost cap, copy cap and type caps.

The search starts from the template rush, the bricks and the turtle plus random
armies. Fitness is the win rate against the 37 round-robin archetypes, using 4
battles per opponent from the spread order, on the lean runner with the cache.
The best builds are then played in full (16 battles per opponent) and reported
with their best counters. Builds above 70% go on a **watch list** (since
2026-10-24, the user's call; it used to fail the run): the CLI prints each with the
archetypes that beat it, to review before the event. Exit code 0; `--strict` exits 1
when the watch list isn't empty.
Support units, walls and factories are not searched yet.

```
npm run balance:exploit                                  # 8 generations × 20 armies, seed 1
npm run balance:exploit -- --generations 12 --population 24 --seed 3 --config patch.json --top 5 --json out.json
```

**First run (committed $5,000 config, seed 1, 8 generations × 20 armies, 128 armies,
20,276 battles, 128 s).** Five builds come out above 70% against the 37 archetypes
(16 battles per opponent, both seeds):

| win rate | army | cost | best counters |
|---|---|---|---|
| **86.0%** | 1 ice splash-60 soldier (850 HP, 145 dmg, range 130, speed 0.6, cooldown 80) + 2 glass sniper towers (300 HP, 140 dmg, range 170, cooldown 35) | $4,528 | only the sniper nest (2-4-10) |
| 83.8% | 2 brick-like soldiers (1,700 HP, 255 dmg, cooldown 55, size 12) | $4,924 | the walled nests, fortress, snipers |
| 82.4% | 8 Basic Soldiers + 1 tower (400 HP, 130 dmg, range 170, cooldown 85) | $4,977 | tanks, mortars, bombard, blizzard |
| 81.8% | the first build with a plain splash soldier and range-220 towers | $4,892 | bricks, snipers, bunker, home guard |

Two of these were already known:
- The template rush (open item 10) shows up again as 8 soldiers + 1 tower.
- Bricks with a shorter cooldown and a smaller body are the same bricks.

The new one is a **3-copy ice-splash brawler behind two fast-firing glass sniper
towers** that almost nothing in the archetype pool beats. It is measured against
"chase nearest" bots, so a real player's targeting may answer it better. It is
still the first thing to check in the $10,000 retune: splash and ice prices, and
the tower cooldown price.

## The $10,000 redesign (2026-10-24)

Plan §6 (economy), §9.3 (routing round buildings), §9.4 (accuracy, synergies),
§14 "Redesign balance", §17 "Resolved in the $10,000 redesign request".
**This section supersedes the M8.8 numbers above**: the $10,000 budget, 120 s
battles, 12 fighters, two times the time-to-kill. The old sections stay as history.

### What changed in the sim and the economy

| Item | Value |
|---|---|
| Budget, unit cap | $10,000 per army, $3,000 per unit |
| Fighters | ≤ 12 (≤ 5 factories) + ≤ 16 walls; copy ramp: copies 1-3 of a design at list price, then +15% each (the 12th +135%); walls exempt |
| Bounds | soldier/tower HP 80-4,000, damage 0-240; soldier range 20-160, tower range 20-300; walls 400-12,000; factories 800-8,000, interval 300-1,200 (5-20 s) |
| Prices | base 50, hp 0.1875, damage 1.875, range 1.38, speed 90, size 8, power factor 2; splash 1 + 0.8·ρ(2−ρ); fire and lightning ×1.3, ice ×1.75; heal 3.5; auras haste 9, might 8, shield 7; minion discount 0.5 |
| Battle | 7,200 ticks (120 s); sudden death 75 s → 120 s, 570 → 60 px, 10%/s |
| Synergies | kindle +25% (burning body, non-fire hits), brittle +25% (frozen body, non-ice non-fire hits), shatter ×1.4, overload +2 hops |
| Accuracy | ranged shots miss 20% × min(1, moved / 5 px) of the time; a miss lands where the target was, splash still hits |
| Factories | minions grunt 360/20, archer 240/20, runner 480/24, brute 1,100/32, medic 300 (heal 60); ≤ 12 per factory; alive per player min(12, floor(40 / players)), 40 per battle |
| Routing | towers and factories are walked round like walls (§9.3) |
| Templates | soldier 1,400 HP / 56 dmg $807; tower 1,200 / 72 $1,200; wall 3,200 $149; factory 2,400 @ 600 $2,194 |

### The archetype pool (48)

Every archetype was rebuilt for $10,000 (`tests/helpers/balance.ts`): new-scale
reference units, ≥ 70% of the budget spent, every design legal under `checkStats`.
`resolve()` drops copies of the dearest fixed part until the army fits the budget
with the copy ramp, then fills with the filler; `pad` raises HP and damage in 2%
steps while the army still fits. New archetypes: `soldiersFilled` (a padded
full-12 one-design army), `factories5` (five factories incl. medics), `overload`,
`icebreak`, `exploit` and `exploitIce` (the M8.8 exploit search's builds:
an ice splash soldier + 2 glass sniper towers), `splashline`, `firebrawl`,
`guardedcatapults`, `icemortars`, and the template armies `rush` and `tmix`.
The 6/13/17 sub-matrices are gone: the full matrix is the one gate.

### Tuning (fast CLI, `npm run balance -- --fast --config …`)

Starting from the scaled M8.8 prices, the top archetypes sat at 75-85%
(padded soldiers, shatter, bricks, buffed rush, the exploit builds). TTK ×2
favours blobs: a fight lasts long enough for numbers to tell. In order:

| Lever | Effect |
|---|---|
| unit cap $3,500 → $3,000 | bricks 82% → 79% |
| copy ramp `{3, 15}` (the user's "final approach") | padded mono armies 78-84% → 70-72%; mixed armies +3-5 points. No price change alone got them under 75% without wrecking everything else, so it stays on |
| ice ×1.5 → ×1.75, shatter 50 → 40% | shatter 81% → 64% |
| power factor 1 → 2 | bricks and the padded armies pay for concentrated stats |
| splash 0.7 → 0.8, heal 3.5, heal room 4%/s | splash lines and healer balls ≤ 68% |
| auras 7/6/7 → 9/8/7 | buffed rush 70% → 55% |
| runner minion 480/24, minion discount 0.5 | factories 45-56% (from 30-40%) |
| `cost.speed` 66 → 90 | the exploit search's fast runner armies 94% → 87% |
| soldier range ≤ 160 | mobile splash snipers (range 240-250 soldiers) were 86-94% at any range price |
| sudden death 7 → 10%/s | the turtle won 16/16 Ring 8 free-for-alls; now 7/16 |

### Full matrix (48 archetypes, 752 battles each, seeds 11 and 4242)

`npm run balance -- --full --all --seeds 11,4242`: 18,048 battles in 386 s, **PASS, 237 rules**.

| archetype | wins | archetype | wins | archetype | wins |
|---|---|---|---|---|---|
| bricks | 72.6% (cap) | tanks | 53.2% | archers | 43.2% |
| soldiersFilled | 71.8% (watch) | tmix | 53.1% | blizzard | 41.5% |
| rush | 68.9% | bigFriends | 52.8% | medictent | 38.0% |
| healerball | 68.0% | factories5 | 52.1% | quad | 37.5% |
| splashline | 67.0% | icemortars | 49.5% | bunker | 36.2% |
| guardedcatapults | 67.0% | longbow | 47.5% | hugetanks | 34.8% |
| shatter | 64.1% | icewall | 45.2% | runners | 33.9% |
| brutes | 64.0% | exploitIce | 45.1% | glass | 33.2% |
| exploit | 64.0% | fortress | 44.7% | swarm | 32.6% |
| icebreak | 62.5% | firenest | 44.5% | firebrawl | 31.4% |
| storm | 62.0% | snipewall | 44.0% | firesquad | 30.1% |
| overload | 60.5% | frostnest | 44.0% | templates | 26.3% |
| mortars | 57.8% | | | mixed | 18.4% |
| shieldwall | 57.2% | | | scouts | 11.7% |
| elemfactories | 56.5% | | | | |
| stormrunners | 56.4% | | | | |
| homeguard | 56.3% | | | | |
| buffedrush | 54.5% | | | | |
| snipers | 54.4% | | | | |
| wallrush | 54.1% | | | | |
| turtle | 54.0% | | | | |
| bombard | 53.5% | | | | |

- **Exceptions:** bricks (two max-cost soldiers) is the existing `FULL_DOMINANCE_EXCEPTIONS`
  key, re-recorded at 546/752. `soldiersFilled` (the padded full-12 mono army)
  is the one **watch item** (540/752), allowed slightly over 70% as the brief
  permitted; splash lines, bombard and fire nests beat it 16-0, the overload combo 10-6.
- **Mixed vs mono:** mixed armies win 43.6% of their mixed-vs-mono cells (mono
  average 54.2%, mixed 48.4% overall), so parity is not reached by that number.
  But seven of the top ten are mixed (rush, healerball, splashline,
  guardedcatapults, shatter, exploit, icebreak), and the weak mixed armies are
  the deliberately plain `mixed` and `templates`.
- **Stated outcomes:** 27 hold (45 checks with the shape checks). New ones state
  the redesign's intent: splash and combo armies beat the padded mono army,
  kindle + overload beats the bricks, brittle beats the healer ball, ice mortars
  stop a buffed rush, five factories flood a splash battery, all four templates
  beat soldiers and towers alone. Dropped (the M8.8 meta): frost/blizzard/shatter
  beat bricks, scouts beat snipers, snipers beat bricks, the fortress loses to the
  swarm and the bunker, the swarm beats the turtle, buffed rush beats shatter,
  medics beat mixed.
- **Turtle vs rush** reversed to an even fight (25-75% either way); the Lanes
  turtle team holds. **Ring 8 FFA:** turtle 7/16 (was 16/16 at 7%/s), snipers 9/16
  (the re-keyed free-for-all exception).
- Seed 11 alone: bricks 71.5%, soldiersFilled 71.8%; every other archetype ≤ 70%.
- Scouts (11.7%): accuracy did not make scouts strong. A scout army dodges up to
  20% of shots, but 12 cheap scouts still lose to splash and to any brawler.

### Tests

`npm test` (main pass): 64 files, 1,187 tests. Timing pass 54/54 (engine p99
< 1 ms with routing round buildings; 8-player 120 s battle within budget).
Balance pass 103/103 in ~25 s warm (`PIXEL_CLASH_PERF=balance`).

### Exploit search (final)

`npm run balance:exploit -- --generations 10 --population 24` on the committed config
(seed 1, 196 armies, 40,512 battles, 558 s). The search now covers the 48 archetypes,
the copy ramp and the soldier range cap. **Five builds above 70%**, all one family:

| win rate | army | cost | best counters |
|---|---|---|---|
| **93.6%** | 1 ice splash-80 soldier (480 HP, 112 dmg, range 130, cd 75) + 2 fast heavy brawlers (1,760 HP, 40 dmg, speed 3.2) + 2 slow lightning brawlers (1,600 HP, 116 dmg, range 70) + 2 towers (1,040 HP, 52 dmg, range 150) | $9,950 | longbow 5-1-10 |
| 92.4% | the same, one splash-20 tower (640 HP, 116 dmg) instead of the two towers | $9,677 | longbow 3-0-13 |
| 91.0% | no towers, 3 fast brawlers | $9,743 | guarded catapults 0-0-16, bombard 2-0-14, fire nest 7-0-9 |

Earlier searches during tuning found the other families, each answered by a lever above:
mobile splash snipers (range 240-250 soldiers, 86-94%: the soldier range cap) and
fast runner armies (94%: `cost.speed` 90). What is left is a **mixed elemental
combo army**: the fast tanks pull fire, a glass ice-splash soldier freezes the
clump, and the lightning brawlers hit frozen bodies (brittle +25%). That is the kind
of army the redesign wants players to find, but it is too strong against the
chase-nearest bots: they spread their fire over the fast tanks and never focus
the 480 HP ice soldier. It is the first pre-event watch item; the levers to try
are the ice price (×1.75 → ×2), the splash price at large radii on glass bodies,
and a bot pool archetype that focuses the weakest enemy. Not changed here.

## Focus fire, backline divers and the exploit watch list (2026-10-24)

The exploit search kept finding one family at 89-94% against the bot pool:
**tanks in front, a fragile ranged or caster hitter behind** (for example 4 brawlers
1,840 HP / 144 dmg + 3 glass archers 240 HP / 140 dmg / range 140; or a glass ice
splash-60 soldier + 3 fast decoy tanks + 2 ranged soldiers).

**Focus fire** (`targeting: 'focus'`, `tests/helpers/brains.ts`): soldiers and towers
pick, among the enemies they can reach (towers: range; soldiers: range + 80 px),
healers first, then other support units and ice or splash casters, then the lowest HP.
Seven archetypes use it (hugetanks, glass, icewall, overload, firebrawl,
guardedcatapults, icemortars). The 48-archetype matrix still passed all 237 rules.
The family stayed at 92-94%.

**No price lever fixes it.** Short re-searches from the family's builds (1 generation,
12 armies) under `cost.damage` 2.2, `cost.range` 2, `powerFactor` 2.5/3/4 and `curveK`
1.5 still found 84-93% builds. Ice ×2 with splash 1.0 found 80%. Each budget refit
undoes a global price change. Pairing a tank with a hitter is also what CLAUDE.md
teaches, and the family has counters in the pool (ice behind walls, ice mortars,
fire nests, the long-bow snipers, guarded catapults, bombard).

**The user's call: "Accept it as healthy + add backline divers".** No price change.
The bot pool gets the counter a player would build, and the exploit search's 70%
bar becomes a watch list.

### The dive and flank brains

- **`dive`** (per soldier design: `soldierBrain: { assassin: 'dive' }`): hunt the
  dive pick **anywhere on the map**, past the front line (the game routes round walls
  and buildings). The pick order is healers, then other support and ice or splash
  casters, then ranged units (range ≥ 100). Walls, factories and minions are never
  picked. Within a rank, the smallest max HP goes first (max HP, so the pick doesn't
  flip as bodies get hurt), then the nearest. With no dive pick left (only a front
  line), the unit fights like a focus soldier. If an enemy wall stops it for 120 ticks,
  it smashes the wall.
- **`flank`**: the same target, but while more than 160 px away the unit heads for a
  waypoint. The waypoint is the midpoint of its line to the target, pushed 180 px to
  the side away from the rest of the enemy army (its centre of mass), and kept inside
  the arena and the safe zone. The unit swings round the front instead of walking
  through it.
- **Factory `dive`**: every minion swarms the dive pick; with none, they swarm the
  weakest (like `swarm`).

All three are self-contained in `brains.ts`, so the lean, node:vm and isolated-vm
runners play them the same. `tests/balance-parity.test.ts` now plays 15 matchups:
assassins vs exploit, cavalry vs healerball (Ring 8) and raiders vs shatter.

### Three diver archetypes ($10,000; `DIVER_ARCHETYPES` in `tests/helpers/balance.ts`)

| key | army | brains | wins (51, both seeds) |
|---|---|---|---|
| `assassins` | 4 Basic Soldiers + 4 Assassins (960 HP, 112 dmg, range 30, speed 3.2, cd 50, size 7) | Assassins flank; focus fire | 65.0% |
| `cavalry` | 3 Basic Soldiers + 5 Cavalry (1,600 HP, 72 dmg, range 30, speed 2.8, cd 55, size 12) | Cavalry dive | 67.5% |
| `raiders` | 11 walls sealing 2 padded Basic Towers + 2 Runner Rushes (burst 4) | factories dive | 51.9% |

These are test bots, so their makeup was tuned and no game number changed. About 30
compositions were tried, and many came out between 30% and 98%. The bar was the
existing caps: bricks could gain at most 34 of the 48 new battles and the padded
soldiers 36. Small changes swing these armies a lot. For example, padding the
assassin pack's designs takes it from 63% to 78%, and an 8th body is worth more than
a 7th. Factory-only runner raids won 32-41%, and every one lost all 16 to the bricks.
The sealed tower base is what lets `raiders` beat the bricks and the padded soldiers.
- **assassins** beat healerball 12-4, rush 10-6, guardedcatapults, icebreak, shatter,
  longbow, raiders. They lose to walls, splash, fire, the shield wall and cavalry.
- **cavalry** beat soldiersFilled 15-1, rush 16-0, assassins 16-0, shatter, icebreak,
  longbow. They lose to walls, splash, fire, healerball 6-10 and raiders 6-10.
- **raiders** beat bricks 9-7, soldiersFilled 14-2, healerball 15-1, rush 14-2, the
  fortress and the walled nests, and cavalry 10-6. They lose to archers, the home
  guard, five factories and the elemental armies.

### Full matrix (51 archetypes, 800 battles each, seeds 11 and 4242)

`npm run balance -- --full --all --seeds 11,4242`: 20,400 battles in 425 s, **PASS,
249 rules** (237 + 12 for the three new rows; 45/45 stated outcomes and shape checks,
no new exception). Bricks 71.4% (under its recorded cap of 72.6%, which stays),
soldiersFilled 69.3% (watch cap 71.8%), splashline 68.5%, cavalry 67.5%,
guardedcatapults 66.3%, healerball 66.0%, exploit 65.9%, rush 65.5%, assassins 65.0%.
At the bottom are mixed 18.3% and scouts 11.0%. No cell between the 48 old archetypes
changed.

### What the divers do to the family

The family's builds from the focus run, replayed against the 51 (16 battles per
opponent): 94.4 → 90.8%, 94.0 → 93.1%, 93.6 → 91.1%, 93.4 → 90.6%, 92.8 → 89.3%.
Head to head, the divers beat the ice-caster builds (cavalry 14-16 of 16, assassins
10-16 of 16), and cavalry beat the 4 brawlers + 3 glass archers 10-6. The raiders lose
to all of them. So the pool now has counters for the family, but it drops only 1-4
points overall. Most of its wins come from efficient brawlers that beat the other 48,
not from the glass hitter. In a sampled battle of assassins (padded) against the 4 brawlers +
3 archers, the divers killed all three archers within 3 s and then lost to the brawlers.

### Exploit search: a watch list, not a failure

`npm run balance:exploit` now lists builds above 70% as a **WATCH LIST**. Each is
printed with the archetypes that beat it, as a pre-event review item. Exit code 0;
`--strict` gives the old exit 1. The `--json` rows carry `watch` and `counters`. The
search also evolves the per-design `dive` / `flank` brain.

**Run (51 archetypes, seed 1, 10 generations × 24 armies, starting from the focus
run's builds; 194 armies, 40,392 battles, 389 s).** All five builds are on the watch
list:

| win rate | army | cost | beaten by |
|---|---|---|---|
| **94.6%** | 3 brawlers (1,680 HP, 144 dmg, range 30, speed 1.9, cd 60) + 1 brawler (1,840 HP, 168 dmg, range 50, speed 1.6, cd 55, **flank**) + 1 glass ice splash-80 caster (480 HP, 96 dmg, range 140) (focus) | $9,913 | icewall 2-0-14, icemortars 4-0-12 |
| 94.0% | the same without the flank brain (size 12) | $9,934 | icemortars 2-0-14, icewall 5-0-11 |
| 93.9% | the same without the flank brain | $9,913 | icemortars, icewall |
| 93.1% | 4 brawlers (1,840 HP, 144 dmg) + 3 glass archers (240 HP, 140 dmg, range 140) (focus) | $9,988 | icewall 0-0-16, icemortars 2-0-14, firenest 4-0-12, **cavalry 6-0-10** |
| 91.1% | 2 fast decoy tanks (one fire) + a glass ice splash-80 soldier + 2 slow lightning brawlers + a splash tower (focus) | $9,998 | **cavalry 2-0-14**, longbow 4-0-12, **assassins 6-0-10** |

The search has moved to **heavy brawlers with a single caster**: five bodies, four of
them 1,700-1,800 HP hitters. There is little back line left to dive, and ice behind
walls is what stops it. **Pre-event review:** each watch-list build has a counter a
player can build, so nothing here blocks the event. If one keeps topping real games,
the brawler's value per dollar (damage × HP at speed 1.6-1.9) is the place to look,
not the ranged or caster prices.

### Teaching

The CLAUDE.md template (shared by the Claude and Codex kits, §4d point 2), the unit
guide's tips (`STRATEGY_TIPS`, so also `get_rules`) and PROMPTS.md now say how to beat a
protected back line: focus their casters first and send fast units round the side
to hunt their fragile shooters. No numbers changed.

## Brittle factories (2026-10-25)

Plan §5.2, §6, §14 "Brittle factories", §17. User request: "Let's scale the factories
to be much more brittle; it should be really easy to destroy them to prevent players
from just building a factory and camping by it, waiting for it to produce units", and
"Factories should still cost about the same as they do now".

### What changed

| | before | now |
|---|---|---|
| `stats.bounds.factoryHealth` | 800-8,000 | **120-1,200** (×3/20) |
| Basic Factory | 2,400 HP | **360 HP** |
| `cost.factory.hp` | 0.075 (curve max 8,000) | **0.5** (curve max 1,200) |
| Factory prices | | **unchanged**: body(HP × 3/20) is the old body(HP), e.g. Basic Factory $2,194, Swarm Factory $2,371, Fortress (max HP, slowest) $2,135 |

No damage-taken factor was needed: lower HP alone makes a reached factory fall in
seconds. A sweep at ×1/5 (160-1,600, template 480) gave the same matrix to within
a battle or two per row, so the bound was set by time-to-kill.

### Time to kill (a lone factory that holds, Duel map, seed 11)

| factory | 1 Basic Soldier | 2 | 3 | 4 | 6 |
|---|---|---|---|---|---|
| 120 HP (min) | 2.0 s | 1.0 s | | | |
| **360 HP (Basic Factory)** | **6.0 s** | **3.0 s** | 2.0 s | 1.4 s | 1.0 s |
| 1,200 HP (max) | 21.0 s | 10.5 s | 7.0 s | **5.4 s** | 3.6 s |
| before: 2,400 HP | 42.0 s | 21.0 s | 14.0 s | 10.4 s | 7.0 s |
| before: 8,000 HP | (sudden death) | 71.0 s | 47.4 s | 35.4 s | 24.0 s |

Asserted in `tests/balance.test.ts` (≤ 6.5 s / ≤ 3.5 s for the Basic Factory, ≤ 6 s
for a 1,200-HP one against four soldiers, ≤ 2.5 s for the minimum).

### Bot fixes (test bots, no game number)

With brittle factories the two pure factory armies collapsed: `homeguard` (4 Swarm
Factories on `defend`) 54.4% → 45.1% and `bunker` (the same on `rally`) 33.9% → 27.4%.
That pushed `exploit` to 70.9% (it went 16-0 against both) and made the shape check
"homeguard beats bunker" 8-8. Both bots were labelled as towers + factories, but at
$2,371 a Swarm Factory the redesign's 4 factories had left no money for towers. They
are now **2 Basic Towers (padded) + 3 Swarm Factories**, as the labels say.

### Full matrix (51 archetypes, 800 battles each, seeds 11 and 4242)

`npm run balance -- --full --all --seeds 11,4242`: **PASS, 249 rules**, 45/45 stated
outcomes and shape checks, no new exception; `npm run balance` (the test's seed) PASS.

| archetype | before | now |
|---|---|---|
| bricks | 71.4% | 72.4% (cap 72.6%, unchanged) |
| soldiersFilled | 69.3% | 70.4% (watch cap 71.8%, unchanged) |
| exploit | 65.9% | 67.8% |
| homeguard (now with towers) | 54.4% | 58.4% |
| brutes | 59.5% | 55.3% |
| elemfactories | 54.8% | 50.6% |
| stormrunners | 54.3% | 50.5% |
| tmix | 50.6% | 49.4% |
| factories5 | 50.0% | 45.6% |
| raiders | 51.9% | 45.0% |
| bunker (now with towers) | 33.9% | 42.1% |
| archers | 42.6% | 38.3% |
| quad | 36.5% | 33.6% |
| medictent | 35.0% | 32.6% |
| swarm | 32.6% | 32.0% |
| runners | 34.1% | 29.0% |

Factory armies lose 1-7 points each and stay spread over 29-58%: still a real
choice. The bricks gain most (raiders 7-9 → 15-1), close to their recorded cap.

### Factory camps (`CAMP_ARCHETYPES`, not in the round robin)

A `camp` soldier brain waits within 160 px of the nearest own factory (the `hold`
brain, anchored on a factory) and fights only what comes near; the minions are on
`defend`. Each camp against the 51 archetypes (both seeds, 816 battles), with the
same armies at the old factory HP for comparison:

| camp | army | now | old HP |
|---|---|---|---|
| `camp` | 3 Swarm Factories + 3 padded Basic Soldiers waiting by them | 62.7% | 55.0% |
| `camptowers` | 2 padded Basic Towers round 3 Basic Factories | 49.9% | 50.6% |
| `campfive` | 3 Steady Factories + Steady Archers + Steady Medics + 2 soldiers waiting | 44.7% | 48.4% |
| `homeguard` | 2 towers + 3 Swarm Factories, minions defend | 56.9% | 52.8% |
| `swarm` (same army as `camp`, attacking) | 3 Swarm Factories + 3 soldiers, rally | 32.4% | 20.8% |

(The old-HP column re-prices the 2,400-HP factories at $247 a body under the new curve
max, so it's approximate.)

**What brittle factories do:** once an attacker reaches a camp, its factories go
first. Against the rush, the bricks and the cavalry every camp loses at least 3 in 4,
and all of its factories die before sudden death (asserted; against the template
rush the camp's three Swarm Factories fall 17-28 s into the battle).

**What they don't do:** most camp wins are standoffs. The camp beats the turtle, the
sniper nests, the walled armies and every `hold` army (soldiers waiting by their
towers) without contact until sudden death. Then the minions walk into the safe circle
(their rally point moves to its centre) while the static towers and the waiting
soldiers burn. Factory HP doesn't enter those battles, so no HP bound changes them.
The `camp` brain also gains from the pool's chase-nearest bots walking into its
soldiers and minions one by one. If camping still pays in real games, the levers are
the standoff rules, not factory HP: for example `defend` minions staying by their
factory when the circle closes (they now walk to its centre), or a factory's minions
dying with it. **Watch item.**

### Exploit search

`npm run balance:exploit` (default: seed 1, 8 generations × 20 armies, a fresh start
rather than the 10 × 24 run from the focus builds above; 126 armies, 28,764 battles,
322 s). The search still designs soldiers and towers only (no factories). All five
builds are on the **watch list**:

| win rate | army | cost | beaten by |
|---|---|---|---|
| **88.4%** | 3 fast splash-20 tanks (1,920 HP, 20 dmg, range 70, speed 2.6, **flank**) + 3 ranged hitters (1,280 HP, 164 dmg, range 120, speed 2.4) | $9,846 | guardedcatapults 0-0-16, firenest 4-0-12, firesquad 6-0-10, buffedrush 7-0-9 |
| 83.2% | the same family, 2 tanks + 4 lighter hitters (880 HP) | $9,500 | guardedcatapults 0-0-16, bombard 2-0-14, firenest 4-0-12, splashline 5-0-11, buffedrush, icemortars, firesquad |
| 77.0% | 4 range-160 splash-20 soldiers (960 HP, 164 dmg, speed 1.3) | $8,446 | bricks, snipers, longbow, healerball, guardedcatapults 0-0-16; shatter, cavalry, tanks |
| 75.9% | the same at size 9 | $8,375 | bricks, snipers, longbow, healerball, guardedcatapults 0-0-16; cavalry, bombard, tanks |
| 70.6% | 5 towers (three range 260-270 splash-40 snipers, two range-120 hitters) | $9,755 | homeguard 0-0-16, cavalry 0-0-16, factories5 1-0-15, brutes, elemfactories, archers, stormrunners, runners |

The same "tanks in front, hitters behind" family as before, at lower rates than the
94% builds of the longer run; nothing here is about factories. The tower build is beaten
outright by the factory armies (homeguard 16-0, factories5 15-1), so factories still
answer a turtle.

## Factories stop at sudden death (2026-10-25)

Plan §5.2, §6, §9.3, §14 "Factories stop at sudden death", §17. The user's chosen option
for the factory camps (verbatim): "Factories stop at sudden death" — "No new minions
once the safe circle starts shrinking, so camps can't out-produce a standoff."

### What was built

`factory.stopAtSuddenDeath` (config + `config/default.json`, /admin quick settings toggle
under Walls & factories). When on:
- no minion appears at or after `suddenDeath.startTick` (4,500); the timers stop and the
  unbuilt minions are gone (`minionsLeft` = `canMake` = 0, the full grey "done" ring on
  /screen); minions already out keep fighting;
- stored burst minions already exist, so they still leave: the store empties itself as
  soon as it can't fill before sudden death, at the latest at sudden death;
- `self.factory.producing` is false once no new minion can appear (always true when off);
- E is priced over the production window: min(12, floor((startTick − 1) / interval)).

**It ships off by default** (judgement call, reversible in one click): the numbers below
show it neither brings the camp down nor keeps the rules passing.

### Prices (with the option on)

| factory | today (off) | on, discount 0.5, cap 12 (honest E) | on, discount 0.79, cap 8 (prices kept) |
|---|---|---|---|
| Basic (360 HP, 600) | $2,194 | $1,486 (E 7) | $2,200 (+0.3%) |
| Swarm (360, 300) | $2,371 | $2,371 (E 12) | $2,479 (+4.6%, E 8) |
| Steady (360, 900) | $1,486 | $955 (E 4) | $1,363 (−8.3%) |
| Fortress (1,200, 1,200) | $2,135 | $1,781 (E 3) | $2,087 (−2.2%) |
| cheapest (120, 1,200) | $996 | $642 (E 3) | $948 (−4.8%) |

With the cap at 12, no single discount keeps both the Swarm Factory (still 12 minions in
75 s) and the slower ones (about 5/8 of their minions) at today's prices: 0.79 keeps the
Basic Factory but makes the Swarm Factory $3,595 (over the $3,000 cap) and the Archer Nest $4,351. Cap 8 plus
0.79 keeps all five within 8%.

### Factory camps (each against the 51 archetypes, both seeds, 816 battles)

| camp | off (today) | on, 0.5 / 12 | on, 0.79 / 8 |
|---|---|---|---|
| `camp` (3 Swarm Factories + soldiers waiting) | 64.1% | 62.3% | 60.5% |
| `camptowers` | 50.6% | 62.9% | 54.5% |
| `campfive` | 45.1% | 55.9% | 46.6% |
| `homeguard` (in the matrix) | 58.4% | 56.5% | 59.2% |

(64.1% counts draws as half against the 51 archetypes; the 62.7% in "Brittle factories"
is the same army under the earlier count.) The camp wins its standoffs with the minions
it already has when the circle starts; new minions after that hardly mattered.

### Full matrix (51 archetypes, 800 battles each, seeds 11 and 4242)

| archetype | off (today) | on, 0.5 / 12 | on, 0.79 / 8 |
|---|---|---|---|
| splashline | 68.2% | 73.9% | 75.4% |
| exploit | 67.8% | 71.4% | 75.1% |
| guardedcatapults | 65.8% | 71.8% | 71.2% |
| bricks | 72.4% | 70.5% | 72.4% |
| soldiersFilled | 70.4% | 69.0% | 70.5% |
| cavalry | 68.4% | 66.8% | 68.5% |
| mortars | 59.2% | 67.2% | 67.1% |
| homeguard | 58.4% | 56.5% | 59.2% |
| factories5 | 45.6% | 60.8% | 44.1% |
| elemfactories | 50.6% | 58.8% | 48.8% |
| stormrunners | 50.5% | 41.9% | 21.6% |
| brutes | 55.2% | 37.0% | 11.1% |
| bunker | 42.1% | 40.2% | 38.5% |
| archers | 38.2% | 37.5% | 37.9% |
| medictent | 32.6% | 23.4% | 33.4% |
| raiders | 45.0% | 53.6% | 41.9% |
| swarm | 32.0% | 25.5% | 24.0% |
| tmix | 49.4% | 23.5% | 29.6% |
| quad | 33.6% | 16.8% | 16.5% |
| runners | 29.0% | 16.5% | 4.6% |

Off: **PASS, 249 rules** (unchanged; `npm run balance` PASS). On, 0.5 / 12: splashline,
exploit and guardedcatapults over the 70% cap and "brutes beat fortress ≥ 3 in 4" fails
(0-16). On, 0.79 / 8: the same three over the cap and the same shape check fails.
Attacking factory armies lose their late waves (brutes, runners, storm runners, the
template mixes); the cheaper slow-factory armies gain (factories5, elemfactories).

### Exploit search with the option on

`npm run balance:exploit -- --config '{"factory":{"stopAtSuddenDeath":true}}'` (seed 1,
8 × 20, 129 armies, 29,376 battles, 485 s): two tower builds on the watch list.

| win rate | army | cost | beaten by |
|---|---|---|---|
| 72.3% | 2 range-260 splash-20 snipers (1,120 HP, 180 dmg) + 2 lightning splash-20 towers (1,280 HP, 80 dmg), focus | $9,424 | homeguard 0-0-16, elemfactories 1-0-15, bricks, archers, shatter, healerball 2-0-14 |
| 70.2% | 2 soldiers (splash tank, ice) + 2 splash-20 towers + 2 lightning towers, hold, focus | $9,442 | archers, homeguard, elemfactories, factories5 0-0-16 |

With the option off nothing changes, so the watch list is the one in "Brittle factories".

### If camping still pays

The levers named in "Brittle factories" remain: `defend` minions staying by their
factory when the circle closes (they now walk to its centre), or a factory's minions
dying with it. **Watch item.**

## Minions die with their factory (2026-10-25)

Plan §5, §5.2, §6, §9.3 (step 9a), §14 "Minions die with their factory", §17. The user's
chosen option for the factory camps (verbatim): "Try 'minions die with their factory'" —
"When a factory is destroyed, its living minions crumble. Brittle factories (6 s for one
soldier) then make camping risky: reach the factory and the whole swarm goes. Measure it
with the fast balance tools; keep it off by default if it misbehaves, like the stop rule."

### What was built

`factory.minionsDieWithFactory` (config + `config/default.json`, /admin quick settings
toggle under Walls & factories, next to "Factories stop at sudden death"). When on:
- step 9a, right after step 9 removes the dead: for each factory removed in step 9
  (instanceId order), every minion of it still alive crumbles in the same tick, in one
  `crumble {ids, factoryId}` event (/screen: a small pooled grey pop per minion, 6
  particles, 3 with reduced motion; the crumble sound once per event);
- credit: the unit whose hit destroyed the factory (`killedBy`) gets +1 kill and the
  minion's value (minionValue) as value destroyed for each crumbled minion, as if it had
  hit each one down; no damage credit. Sudden death kills credit nobody;
- stored minions are lost as before (`lost` event; the factory's value at death already
  counts them);
- minions of other factories are untouched; with no factory destroyed the battle is frame
  for frame the same as with the option off.

Every minion's `OtherView.factoryId` (on or off) is the id of the factory that made it.

**It ships off by default** (judgement call, reversible in one click): the camp falls, but
so does every attacking factory army, and 12 of the 249 rules fail.

### Prices

Unchanged, on or off: Basic $2,194, Swarm $2,371, Steady $1,486, Fortress $2,135,
cheapest $996. A factory still makes E minions if it survives; losing them with it is a
risk of the build, like losing the factory itself.

### Factory camps (each against the 51 archetypes, both seeds, 816 battles; draws count half)

| camp | off (today) | on | stop at sudden death | on + stop |
|---|---|---|---|---|
| `camp` | 62.9% | **42.1%** | 61.6% | 39.6% |
| `camptowers` | 50.1% | 39.2% | 62.3% | 52.2% |
| `campfive` | 44.7% | 26.2% | 56.3% | 37.3% |
| `homeguard` | 57.5% | 36.8% | 56.0% | 36.4% |
| `swarm` (camp army, attacking) | 31.8% | 31.1% | 25.3% | 25.3% |

(The off column is the same count as "Brittle factories"; the 64.1% in "Factories stop at
sudden death" counted the same battles differently.) On, the camp drops well under the
~55% target: reaching a factory now wipes the swarm waiting beside it. Many of its losses
are draws by mutual wipe-out (57 of 816).

### Full matrix (51 archetypes, 800 battles each, seeds 11 and 4242)

| archetype | off (today) | on | on + stop |
|---|---|---|---|
| splashline | 68.2% | **79.9%** | **80.4%** |
| exploit | 67.8% | **76.8%** | **76.8%** |
| guardedcatapults | 65.8% | **76.2%** | **77.0%** |
| overload | 61.0% | **71.5%** | **72.5%** |
| shieldwall | 58.8% | **70.9%** | **71.6%** |
| mortars | 59.2% | 67.1% | **72.8%** |
| icebreak | 60.9% | 68.9% | **72.1%** |
| bricks | 72.4% | 72.4% | 70.5% |
| homeguard | 58.4% | 36.8% | 33.0% |
| brutes | 55.2% | 39.6% | 36.4% |
| elemfactories | 50.6% | 25.6% | 26.6% |
| stormrunners | 50.5% | 25.1% | 42.0% |
| tmix | 49.4% | 30.0% | 24.0% |
| factories5 | 45.6% | 20.4% | 33.8% |
| raiders | 45.0% | 40.8% | 55.4% |
| archers | 38.2% | **7.8%** | **7.8%** |
| quad | 33.6% | 15.0% | 15.2% |
| runners | 29.0% | 24.5% | 16.8% |

Off: **PASS, 249 rules** (bit-identical to before). On: **FAIL, 12 rules**: splashline,
exploit, guardedcatapults, overload and shieldwall over the 70% cap; "archers beat turtle /
fortress / snipewall", "homeguard beats bunker", "archers beat someone",
"factories5 > mortars" and "homeguard > mortars". On + stop: **FAIL, 15 rules** (the same
plus mortars and icebreak over the cap and "brutes beat fortress ≥ 3 in 4", 0-16).

Attacking factory armies collapse like with the stop rule, and worse: their factories sit
at home while the minions are away, so any raider or splash shot that reaches a 360-HP
factory deletes the whole wave (the archer nest's four archer factories behind 4 walls:
38% → 8%). The splash and tower armies that the factory armies used to counter go over the
cap.

### Exploit search with the option on

`npm run balance:exploit -- --config '{"factory":{"minionsDieWithFactory":true}}'` (seed 1,
8 × 20, 126 armies, 28,764 battles, 555 s): five builds on the watch list at 75.9-76.6%,
all one family: a splash-20 melee tank, two melee hitters, two range-160 lightning splash
soldiers and a range-160-210 tower, `hold` + focus ($9,449-9,815). Beaten by exploit
(2-0-14), healerball, brutes, splashline, bricks (0-0-16 for the 8-copy variant). With the
option off nothing changes, so the watch list is the one in "Brittle factories" (top
88.4%).

### Where this leaves the camp

Both measured rules for the camp are off by default. "Minions die with their factory" is
the one that actually breaks camping (62.9% → 42.1%), but in the bot pool it costs every
factory army that attacks. If it is wanted at the event, it needs a counterweight for
attacking factories first (e.g. more factory HP when the option is on, or minions
crumbling only within some distance of their factory). **Watch item.** (The distance was
measured next: "Only minions near the factory crumble" below.)

## Only minions near the factory crumble (2026-10-25)

Plan §5.2, §9.3 (step 9a), §14 "Only minions near the factory crumble", §17. The user's
chosen option (verbatim): "Only minions NEAR the factory crumble" — "When a factory dies,
only its minions within ~200 px of it crumble (the camp's defenders); minions out
attacking keep fighting. Targets camping specifically. Measure on vs off; default on only
if every rule passes."

### What was built

`factory.crumbleRadius` (px; config + `config/default.json`; /admin quick settings
"Crumble distance" under Walls & factories, next to the "Minions die with their factory"
toggle). With `factory.minionsDieWithFactory` on, step 9a crumbles only the factory's
minions whose **centre is within `crumbleRadius` px of the factory's centre** (distance ≤
radius, positions after the tick's movement; `withinCrumbleRadius` in `sim/minion.ts`).
Its minions further away keep fighting. **0 = every minion, wherever it is** (the full
crumble of "Minions die with their factory"). Credit is unchanged: the factory's killer
gets a kill and minionValue per crumbled minion; sudden-death factory deaths credit
nobody. Off (the default), battles are bit-identical whatever the radius. get_rules
(`factories.crumbleRadius`, only when on), the guide and the kit state the radius as a
fact of the option.

**Default: the option stays off; the radius is 120 px** (used when a host turns it on).
No radius met the targets: the only radius that keeps every rule (120) barely moves the
camp (62.9% → 60.4%), and the camp gets to ≤ ~55% only at 320+ px, where rules fail.

### Radius sweep

Camps: each camp against the 51 archetypes, both seeds, 816 battles, draws half (exact).
The other columns: the archetype's row in `npm run balance -- --full --all --seeds
11,4242` (wins / battles), except the rows marked *fast* (`--fast`, the same verdicts at
about a quarter of the battles; their win rates are estimates over the battles played
and run higher or lower than the full ones, so compare only the verdicts and the camp
columns). Full crumble (radius 0) is the "Minions die with their factory" run.

| radius | camp | camptowers | campfive | homeguard | swarm | archers | factories5 | quad | elemfactories | stormrunners | tmix | brutes | runners | raiders | rules |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| off | 62.9% | 50.1% | 44.7% | 58.4% | 32.0% | 38.3% | 45.6% | 33.6% | 50.6% | 50.5% | 49.4% | 55.3% | 29.0% | 45.0% | **PASS 249** |
| **120** | 60.4% | 49.1% | 44.4% | 56.8% | 31.4% | 38.1% | 44.8% | 31.0% | 50.2% | 49.1% | 46.1% | 54.8% | 30.8% | 42.9% | **PASS 249** |
| 160 | 60.4% | 50.8% | 44.4% | 57.9% | 31.4% | 38.1% | 42.5% | 24.0% | 48.0% | 49.1% | 46.1% | 50.9% | 30.8% | 42.6% | FAIL 1: splashline 70.4% |
| 200 | 60.1% | 50.9% | 44.1% | 58.5% | 31.4% | 38.0% | 42.0% | 20.9% | 46.5% | 49.1% | 46.0% | 51.2% | 30.9% | 41.5% | FAIL 1: splashline 70.5% |
| 260 | 59.8% | 53.1% | 43.1% | 60.4% | 31.4% | 36.6% | 41.6% | 21.0% | 37.0% | 49.3% | 46.0% | 50.4% | 30.5% | 41.1% | FAIL 2: splashline 71.4%, exploit 70.8% |
| 320 *fast* | 55.3% | 46.3% | 38.1% | 44.5% | 24.4% | 30.7% | 30.1% | 25.0% | 33.3% | 21.5% | 25.3% | 45.5% | 24.4% | 33.3% | FAIL 3: exploit (74.0% est.), factories5 > mortars, homeguard > mortars |
| 400 *fast* | 48.4% | 44.7% | 30.9% | 38.1% | 24.7% | 20.7% | 25.0% | 23.2% | 31.1% | 21.8% | 23.7% | 40.1% | 22.1% | 35.2% | FAIL 6: exploit, archers' 3 shape checks, factories5 / homeguard > mortars |
| 0 (all) | 42.1% | 39.2% | 26.2% | 36.8% | 31.1% | 7.8% | 20.4% | 15.0% | 25.6% | 25.1% | 30.0% | 39.6% | 24.5% | 40.8% | FAIL 12 |

With "Factories stop at sudden death" too (*fast*; camps exact):

| radius + stop | camp | camptowers | campfive | rules |
|---|---|---|---|---|
| stop alone | 61.6% | 62.3% | 56.3% | FAIL 4 (§ "Factories stop at sudden death") |
| 120 + stop | 59.6% | 60.6% | 55.5% | FAIL 2: exploit (72.9% est.), brutes beat fortress (0-0-4) |
| 200 + stop | 58.6% | 62.2% | 54.5% | FAIL 2: the same |
| 260 + stop | 57.3% | 64.2% | 54.7% | FAIL 2: the same |
| 0 + stop | 39.6% | 52.2% | 37.3% | FAIL 15 |

The stop rule's own failures (brutes vs fortress, the tower builds over the cap) stay at
every radius, so no stop combination passes.

### Why near-only crumbling misses the camp

The camp's defenders are where the user expected them before sudden death (minions
waiting within ~120 px of their factory: radius 120 already crumbles them when a unit
breaks in), but that is not where the camp wins. A diagnostic of the full-crumble run
(camp vs the 51 archetypes, a quarter of the battles, every camp-factory crumble
classified): 140 of 208 camp factory deaths came **after sudden death started, 138 of
them to the sudden-death damage itself** (no hit on the factory in its death frame), and
those crumbled 549 of the 663 minions, 513 of them 200-400 px from their factory (the minions had walked into the shrinking circle while the
factories burned at the zone's edge). Before sudden death, 114 minions crumbled, 112 of
them within 120 px. So the full crumble's camp drop (62.9% → 42.1%) came almost entirely
from sudden-death factory deaths taking far-away minions with them, and a radius small
enough to spare attacking minions (≤ 200 px) spares those too. Only 320+ px catches them,
and by then attacking factory armies are back to the full-crumble collapse.

### Exploit search (radius 120, option on)

`npm run balance:exploit -- --config '{"factory":{"minionsDieWithFactory":true,"crumbleRadius":120}}'`
(seed 1, 8 × 20, 127 armies, 28,968 battles, 355 s). Five builds on the watch list, all
soldier families already known with the option off (top 86.0% vs 88.4% off):

| win rate | army | cost | beaten by |
|---|---|---|---|
| 86.0% | 3 ranged hitters (880 HP, 164 dmg, range 120) + 4 splash-40 melee (880 HP, 56 dmg) + 1 diver, focus | $9,808 | icemortars 0-0-16, firenest, splashline, guardedcatapults 2-0-14, healerball |
| 84.7% | 6 splash-40 melee + 1 range-160 fire splash-40 soldier | $9,662 | snipewall, longbow, bombard, guardedcatapults 0-0-16, exploit 2-0-14 |
| 83.0% | an ice flank tank + 4 ranged hitters (164 dmg, range 120), focus | $9,472 | bricks, cavalry 0-0-16, healerball, buffedrush, shieldwall 2-0-14 |
| 82.8% | 2 splash-20 flank tanks + 4 ranged hitters, focus | $9,324 | healerball 0-0-16, buffedrush 2-0-14, firesquad, firenest |
| 82.0% | 6 splash-40 melee + 1 range-160 splash-40 soldier | $9,106 | snipewall, longbow, bombard, icebreak, exploit 0-0-16 |

Nothing factory-related, every build has 0-0-16 counters: no new exception.

### Where this leaves the camp

Off by default, as the user asked ("default on only if every rule passes" and the camp
target). Radius 120 is the closest: every rule passes and attacking factory armies stay
within ~3 points of off (quad 33.6% → 31.0%), but the camp only goes 62.9% → 60.4%. The
lever the measurements point at (not built, not chosen): what happens to minions when
their factory dies **to sudden death** (e.g. those deaths crumble every minion of the
factory, or factories outside the circle stop counting), since that is where the camp's
standoff wins come from. **Watch item.**

## Factories die at sudden death (2026-10-25)

Plan §5.2, §9.3 (step 8b), §14 "Factories die at sudden death", §17. The user's request
(verbatim): "just add an option that makes factories die at sudden death. Enable it by
default. Implement this and commit it; then after that you can do some measurements and
let me know the outcomes." `factory.dieAtSuddenDeath` (commit 7ca5f59) destroys every
factory still standing on the first sudden-death tick (4,500), credited to nobody; stored
minions are lost, minions already out keep fighting. Prices are unchanged. **It ships on
by default, as asked. The measurements below fail 4 rules with it on; the default was not
changed and no rule was loosened (the user decides).**

### Full matrix (51 archetypes, 800 battles each, seeds 11 and 4242)

`npm run balance -- --full --all --seeds 11,4242 --extra camp,camptowers,campfive`, with
the default (on) and with `--config '{"factory":{"dieAtSuddenDeath":false}}'` (off; the
same numbers as "off" in "Only minions near the factory crumble"). Camps: each camp
against the 51 archetypes, 816 battles, draws half.

| archetype | off | **on (default)** | change |
|---|---|---|---|
| `camp`* | 62.9% | **66.7%** | +3.8 |
| `camptowers`* | 50.1% | 55.9% | +5.8 |
| `campfive`* | 44.7% | 45.5% | +0.8 |
| homeguard | 58.4% | 64.6% | +6.3 |
| brutes | 55.3% | 15.9% | −39.4 |
| stormrunners | 50.5% | 12.8% | −37.8 |
| runners | 29.0% | 4.0% | −25.0 |
| tmix | 49.4% | 29.6% | −19.8 |
| quad | 33.6% | 17.1% | −16.5 |
| factories5 | 45.6% | 37.6% | −8.0 |
| elemfactories | 50.6% | 44.8% | −5.9 |
| archers | 38.3% | 36.5% | −1.8 |
| swarm | 32.0% | 31.4% | −0.6 |
| raiders | 45.0% | 44.9% | −0.1 |
| bunker | 42.1% | 42.5% | +0.4 |
| splashline | 68.3% | **75.6%** | +7.4 |
| exploit | 67.8% | **73.0%** | +5.2 |
| bricks | 72.4% | 72.4% (cap 72.6%) | 0 |
| guardedcatapults | 65.8% | **71.8%** | +6.0 |
| soldiersFilled | 70.4% | 70.4% (cap 71.8%) | 0 |
| cavalry | 68.4% | 68.4% | 0 |
| overload | 61.0% | 68.1% | +7.1 |
| mortars | 59.3% | 67.6% | +8.4 |

\* not in the round robin. The top 8 with it on: splashline 75.6%, exploit 73.0%, bricks
72.4%, guardedcatapults 71.8%, soldiersFilled 70.4%, cavalry 68.4%, overload 68.1%,
mortars 67.6%. Every static army that faces factories gains 5-9 points (turtle +9.0,
shieldwall +8.5, mortars +8.4, snipers +8.3, the walled nests +7-8); armies without
factories that never meet one are unchanged.

**Off: PASS, 249 rules. On: FAIL, 4 of 249 rules:**
- full: splashline wins ≤ 70% (75.6%);
- full: exploit wins ≤ 70% (73.0%);
- full: guardedcatapults wins ≤ 70% (71.8%);
- shape: brutes beat fortress ≥ 3 in 4 (0-0-16; it was a pass off).

The balance test pass (`PIXEL_CLASH_PERF=balance npx vitest run`, 114 tests) **fails 2**
with the default: the full-matrix test (its first failing assertion: exploit 290 of 400
on seed 11, 72.5%) and the M8.6 stated outcome "a burst of 4 runners loses fewer minions
per kill than the same runners sent one at a time" (burst 9.6 vs trickle 6.0 lost per
kill; a stored burst is lost when its factory dies at sudden death). Both pass with
`BALANCE_FIT='{"factory":{"dieAtSuddenDeath":false}}'`. Parity and cache files pass.

**What it does:** attacking factory armies lose the production they would have kept
past 4,500 ticks and any stored burst, so the factory rushes collapse (brutes, storm
runners, runners, the template mix, the quad) and the static armies that used to lose to
their late waves gain. The camp does not drop: it wins its standoffs with the minions it
already has out when the circle starts (as in "Only minions near the factory crumble"),
and its opponents' factories now die too, so `camp` rises 62.9% → 66.7%.

**`--fast` warning:** on this config `npm run balance -- --fast --verify --seeds
11,4242` disagrees with the full matrix on 2 rules (splashline and guardedcatapults ≤ 70%
pass in `--fast`, fail in full; its splashline estimate is 63.3%). It is the first config
where `--verify` found a difference, so confirm any decision with `--full` (see
[Sweeps](#sweeps-and-the-relevance-aware-cache-2026-10-25)).

### Exploit search with the default

`npm run balance:exploit -- --generations 6 --population 16 --top 3` (seed 1, 79
armies, 17,952 battles, 331 s): three builds on the watch list, no factories in any.

| win rate | army | cost | beaten by |
|---|---|---|---|
| 87.3% | a range-120 diver + 2 fast melee + a range-160 splash-20 soldier + 2 range-130 fire soldiers, focus | $8,968 | cavalry 0-0-16, healerball 1-0-15, bricks, buffedrush 4-0-12 |
| 81.7% | the same family with 2 range-130 fire towers | $9,331 | healerball 0-0-16, snipers 2-0-14, icebreak, longbow |
| 71.7% | an ice tank + 5 small towers + 2 splash-20 snipers, hold, focus | $9,595 | archers, homeguard, healerball, elemfactories, factories5, assassins, cavalry 0-0-16 |

The tanks-in-front, hitters-behind family is the one known with the option off (88.4%
top in "Brittle factories"); each build has 0-0-16 counters.

### Together with "minions die with their factory"

With the default on, `factory.minionsDieWithFactory` on and `crumbleRadius` 120 (the
sweep's `--confirm`, full, both seeds): every factory's near minions crumble at sudden
death, so the camps collapse (`camp` 16.8%, `camptowers` 41.5%, `campfive` 3.3%), but so
do factory armies (archers 0%, elemfactories 10.6%, brutes 11.4%) and **15 rules fail**
(8 archetypes over 70%, archers beat nobody, archers' 3 shape checks, homeguard vs
bunker, brutes vs fortress, factories5 / homeguard > mortars). Radius 200 gives the same
verdicts (`--fast`).
