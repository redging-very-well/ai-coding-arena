# Economy reference values

Expected prices at the default config, computed independently of `packages/shared/src/cost.ts`.
Parsed by `tests/cost.test.ts`, `tests/cost-curve.test.ts` and `tests/buildings-cost.test.ts`:
keep the headings, the marker lines and the table columns.

### Factor tables

Factor lines:

```text
splash 10:×1.19 20:×1.35 30:×1.49 40:×1.6 50:×1.69 60:×1.75 70:×1.79 80:×1.8
heal reach 20:×0.69 60:×1.01 100:×1.25 120:×1.34 160:×1.46 200:×1.5
aura radius 40:×0.96 60:×1.14 80:×1.28 100:×1.39 120:×1.46 150:×1.5
curve k=1 0.25: ×1.06 | 0.5: ×1.25 | 0.75: ×1.56 | 0.9: ×1.81 | 1: ×2
power corners 1400/56:×1.16 4000/80:×1.67 480/240:×1.24 640/200:×1.27 2480/180:×1.93 2000/120:×1.5 4000/240:×3
copy ramp 1:×1 2:×2 3:×3 4:×4.15 5:×5.45 6:×6.9 8:×10.25 10:×14.2 12:×18.75
```

The copy-ramp line reads: n copies of a $1,000 design cost n × $1,000 × that factor.

### Reference units (curve k = 1)

**$5,000 game** is the price of the same unit in the previous economy (its HP ÷1.6, damage ÷0.8, heal ÷1.6, priced with that economy's coefficients). "rejected" = over the $3,000 cap.

| Unit | Type | HP | Dmg | Range | Spd | Size | CD | Element | Splash | Support | Linear | Curve | Heal | Sum | CD f | Power | Splash f | Elem f | Aura | Raw | **Cost** | $5,000 game |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Basic Soldier (template) | soldier | 1400 | 56 | 40 | 1.5 | 10 | 60 |  |  |  | 639.7 | +53.62 |  | 693.32 | ×1 | ×1.16 | ×1 | ×1 |  | 806.56 | **$807** | $687 |
| Basic Tower (template) | tower | 1200 | 72 | 140 | 0 | 14 | 45 |  |  |  | 667.2 | +95.37 |  | 762.57 | ×1.33 | ×1.18 | ×1 | ×1 |  | 1199.78 | **$1,200** | $1,072 |
| Half Tank | soldier | 2000 | 80 | 40 | 0.8 | 20 | 60 |  |  |  | 814.2 | +225.24 |  | 1039.44 | ×1 | ×1.33 | ×1 | ×1 |  | 1385.92 | **$1,386** | $1,122 |
| Huge Tank | soldier | 3600 | 80 | 40 | 0.8 | 20 | 60 |  |  |  | 1114.2 | +678.24 |  | 1792.44 | ×1 | ×1.6 | ×1 | ×1 |  | 2867.91 | **$2,868** | $2,092 |
| Sniper Tower | tower | 640 | 160 | 280 | 0 | 14 | 60 |  |  |  | 920.4 | +493.9 |  | 1414.3 | ×1 | ×1.21 | ×1 | ×1 |  | 1716.02 | **$1,717** | $1,505 |
| Slow Sniper (the trap) | tower | 640 | 160 | 280 | 0 | 14 | 90 |  |  |  | 920.4 | +493.9 |  | 1414.3 | ×1 | ×1.21 | ×1 | ×1 |  | 1716.02 | **$1,717** | $1,505 |
| Max Sniper | tower | 640 | 200 | 300 | 0 | 14 | 60 |  |  |  | 1023 | +698.39 |  | 1721.39 | ×1 | ×1.27 | ×1 | ×1 |  | 2180.42 | **$2,181** | $1,860 |
| Glass Cannon | soldier | 480 | 240 | 40 | 2 | 8 | 60 |  |  |  | 841.2 | +481.4 |  | 1322.6 | ×1 | ×1.24 | ×1 | ×1 |  | 1640.03 | **$1,641** | $1,359 |
| Max-cost Brick | soldier | 2480 | 180 | 40 | 1.5 | 16 | 60 |  |  |  | 1122.7 | +422.54 |  | 1545.24 | ×1 | ×1.93 | ×1 | ×1 |  | 2982.31 | **$2,983** | $1,927 |
| Speedy Scout | soldier | 480 | 24 | 30 | 4 | 6 | 20 |  |  |  | 586.4 | +232.56 |  | 818.96 | ×3 | ×1.02 | ×1 | ×1 |  | 2515.85 | **$2,516** | $1,999 |
| Scout with cooldown 10 | soldier | 480 | 24 | 30 | 4 | 6 | 10 |  |  |  | 586.4 | +232.56 |  | 818.96 | ×6 | ×1.02 | ×1 | ×1 |  | 5031.69 | **$5,032**, rejected | $3,998 |
| Laser Sniper (soldier) | soldier | 800 | 80 | 150 | 2 | 10 | 30 |  |  |  | 769 | +105.83 |  | 874.83 | ×2 | ×1.13 | ×1 | ×1 |  | 1982.95 | **$1,983** | $1,704 |
| Half stats at CD 60 | soldier | 2000 | 120 | 150 | 2.5 | 13 | 60 |  |  |  | 1138 | +272 |  | 1410 | ×1 | ×1.5 | ×1 | ×1 |  | 2115 | **$2,115** | $1,536 |
| Max stats at CD 60 | soldier | 4000 | 240 | 160 | 5 | 20 | 60 |  |  |  | 2032.8 | +1824.81 |  | 3857.61 | ×1 | ×3 | ×1 | ×1 |  | 11572.82 | **$11,573**, rejected | $5,789 |
| Everything maxed | soldier | 4000 | 240 | 160 | 5 | 20 | 10 |  |  |  | 2032.8 | +1824.81 |  | 3857.61 | ×6 | ×3 | ×1 | ×1 |  | 69436.9 | **$69,437**, rejected | $34,730 |
| Cheapest legal | tower | 80 | 0 | 20 | 0 | 6 | 600 |  |  |  | 92.6 | +0.13 |  | 92.73 | ×1 | ×1 | ×1 | ×1 |  | 92.73 | **$93** | $93 |
| Fire Soldier | soldier | 1400 | 56 | 40 | 1.5 | 10 | 60 | fire |  |  | 639.7 | +53.62 |  | 693.32 | ×1 | ×1.16 | ×1 | ×1.3 |  | 1048.53 | **$1,049** | $824 |
| Ice Soldier | soldier | 1400 | 56 | 40 | 1.5 | 10 | 60 | ice |  |  | 639.7 | +53.62 |  | 693.32 | ×1 | ×1.16 | ×1 | ×1.75 |  | 1411.48 | **$1,412** | $824 |
| Lightning Soldier | soldier | 1400 | 56 | 40 | 1.5 | 10 | 60 | lightning |  |  | 639.7 | +53.62 |  | 693.32 | ×1 | ×1.16 | ×1 | ×1.3 |  | 1048.53 | **$1,049** | $824 |
| Fire Tower | tower | 1200 | 72 | 140 | 0 | 14 | 45 | fire |  |  | 667.2 | +95.37 |  | 762.57 | ×1.33 | ×1.18 | ×1 | ×1.3 |  | 1559.72 | **$1,560** | $1,287 |
| Ice Tower | tower | 1200 | 72 | 140 | 0 | 14 | 45 | ice |  |  | 667.2 | +95.37 |  | 762.57 | ×1.33 | ×1.18 | ×1 | ×1.75 |  | 2099.62 | **$2,100** | $1,287 |
| Storm Tower | tower | 1200 | 72 | 140 | 0 | 14 | 45 | lightning |  |  | 667.2 | +95.37 |  | 762.57 | ×1.33 | ×1.18 | ×1 | ×1.3 |  | 1559.72 | **$1,560** | $1,287 |
| Frost Archer | soldier | 640 | 32 | 140 | 1.5 | 9 | 60 | ice |  |  | 582.2 | +59.47 |  | 641.67 | ×1 | ×1.04 | ×1 | ×1.75 |  | 1170.83 | **$1,171** | $733 |
| Frost Sniper | tower | 640 | 144 | 280 | 0 | 14 | 60 | ice |  |  | 890.4 | +457.77 |  | 1348.17 | ×1 | ×1.19 | ×1 | ×1.75 |  | 2812.28 | **$2,813** | $1,711 |
| Max-HP tank (the cap) | soldier | 4000 | 80 | 40 | 0.8 | 20 | 60 |  |  |  | 1189.2 | +881.49 |  | 2070.69 | ×1 | ×1.67 | ×1 | ×1 |  | 3451.15 | **$3,452**, rejected | $2,462 |
| Mortar Tower | tower | 1000 | 80 | 140 | 0 | 14 | 60 |  | 40 |  | 644.7 | +91.36 |  | 736.06 | ×1 | ×1.17 | ×1.6 | ×1 |  | 1373.98 | **$1,374** | $1,179 |
| Fire Mortar | tower | 1000 | 80 | 140 | 0 | 14 | 60 | fire | 40 |  | 644.7 | +91.36 |  | 736.06 | ×1 | ×1.17 | ×1.6 | ×1.3 |  | 1786.17 | **$1,787** | $1,415 |
| Fireball Catapult | tower | 960 | 120 | 220 | 0 | 14 | 60 | fire | 40 |  | 822.6 | +250.79 |  | 1073.39 | ×1 | ×1.24 | ×1.6 | ×1.3 |  | 2768.48 | **$2,769** | $2,106 |
| Blizzard Totem | tower | 1040 | 0 | 160 | 0 | 14 | 60 | ice | 60 |  | 529.8 | +96.89 |  | 626.69 | ×1 | ×1 | ×1.75 | ×1.75 |  | 1919.22 | **$1,920** | $1,246 |
| Fire Bomber | soldier | 1120 | 48 | 40 | 1.2 | 12 | 60 | fire | 30 |  | 561.2 | +36.08 |  | 597.28 | ×1 | ×1.11 | ×1.49 | ×1.3 |  | 1284.35 | **$1,285** | $1,003 |
| Max-splash fire brick | soldier | 2400 | 160 | 40 | 1.5 | 16 | 60 | fire | 80 |  | 1070.2 | +349.28 |  | 1419.48 | ×1 | ×1.8 | ×1.8 | ×1.3 |  | 5978.85 | **$5,979**, rejected | $3,492 |
| Field Medic | soldier | 800 | 0 | 20 | 1.5 | 10 | 60 |  |  | heal 96 / 120 px | 394.6 | +20.88 | 476.17 | 891.66 | ×1 | ×1 | ×1 | ×1 |  | 891.66 | **$892** | $759 |
| Healing Shrine | tower | 1280 | 0 | 20 | 0 | 14 | 60 |  |  | heal 128 / 160 px | 381.6 | +45.6 | 721.06 | 1148.25 | ×1 | ×1 | ×1 | ×1 |  | 1148.25 | **$1,149** | $1,007 |
| Battle Cleric | soldier | 1000 | 32 | 40 | 1.5 | 10 | 60 |  |  | heal 64 / 100 px | 519.7 | +28.53 | 287.17 | 835.4 | ×1 | ×1.07 | ×1 | ×1 |  | 891.09 | **$892** | $755 |
| Rapid Medic (CD 30) | soldier | 800 | 0 | 20 | 1.5 | 10 | 30 |  |  | heal 96 / 120 px | 394.6 | +20.88 | 476.17 | 891.66 | ×2 | ×1 | ×1 | ×1 |  | 1783.32 | **$1,784** | $1,518 |
| War Drummer | soldier | 800 | 0 | 20 | 1.5 | 10 | 60 |  |  | might 30% / 100 px | 394.6 | +20.88 |  | 415.48 | ×1 | ×1 | ×1 | ×1 | +453.33 | 868.82 | **$869** | $603 |
| Wind Banner | soldier | 800 | 0 | 20 | 1.5 | 10 | 60 |  |  | haste 30% / 100 px | 394.6 | +20.88 |  | 415.48 | ×1 | ×1 | ×1 | ×1 | +510 | 925.48 | **$926** | $660 |
| Shield Bearer | soldier | 1600 | 24 | 30 | 1.2 | 14 | 60 |  |  | shield 25% / 80 px | 608.4 | +75.98 |  | 684.38 | ×1 | ×1.08 | ×1 | ×1 | +312.04 | 1051.17 | **$1,052** | $982 |
| Haste Totem | tower | 800 | 0 | 20 | 0 | 12 | 60 |  |  | haste 30% / 120 px | 275.6 | +14.94 |  | 290.54 | ×1 | ×1 | ×1 | ×1 | +536.11 | 826.65 | **$827** | $589 |
| Max might pole | tower | 80 | 0 | 20 | 0 | 6 | 60 |  |  | might 50% / 150 px | 92.6 | +0.13 |  | 92.73 | ×1 | ×1 | ×1 | ×1 | +1200 | 1292.73 | **$1,293** | $693 |
| Max shield pole | tower | 80 | 0 | 20 | 0 | 6 | 60 |  |  | shield 40% / 150 px | 92.6 | +0.13 |  | 92.73 | ×1 | ×1 | ×1 | ×1 | +840 | 932.73 | **$933** | $933 |
| Max healer | soldier | 800 | 0 | 20 | 1.5 | 10 | 30 |  |  | heal 400 / 200 px | 394.6 | +20.88 | 4200 | 4615.48 | ×2 | ×1 | ×1 | ×1 |  | 9230.97 | **$9,231**, rejected | $7,503 |

Notes on the table:
- The Slow Sniper has ⅔ the DPS at the same price (`W_SLOW_NO_DISCOUNT`).
- The Huge Tank is about the most HP a damage-80 soldier gets under the cap; the max-HP tank (4,000) is rejected (power ×1.67).
- The Max-cost Brick is the most HP × damage a range-40, speed-1.5, size-16 soldier gets under the cap: power ×1.93.
- Soldier ranges stop at 160 (towers out-range soldiers), so the "max stats" rows use range 160.

### Reference walls, minions and factories (curve k = 1)

Walls, `raw = 20 + 0.0375·HP·(1 + (HP/12000)²)`:

| HP | Linear | Curve | Raw | **Cost** |
|---|---|---|---|---|
| 400 | 35 | +0.02 | 35.02 | **$36** |
| 1200 | 65 | +0.45 | 65.45 | **$66** |
| 2400 | 110 | +3.6 | 113.6 | **$114** |
| 3200 | 140 | +8.53 | 148.53 | **$149** |
| 4800 | 200 | +28.8 | 228.8 | **$229** |
| 6400 | 260 | +68.27 | 328.27 | **$329** |
| 8000 | 320 | +133.33 | 453.33 | **$454** |
| 12000 | 470 | +450 | 920 | **$920** |

400 HP is the minimum, 3,200 HP is the Basic Wall template, and 12,000 HP is the maximum.

Minions are priced with the soldier formula at CD 60. The element factor is the unit's (fire 1.3, ice 1.75, lightning 1.3) and minionValue = ceil(cost × 0.5). Each cell reads: raw → minionCost → **minionValue**.

| Kind | HP | Dmg | Range | Spd | Size | normal | fire | ice | lightning |
|---|---|---|---|---|---|---|---|---|---|
| grunt | 360 | 20 | 20 | 1.5 | 8 | 352.21 → $353 → **$177** | 457.87 → $458 → **$229** | 616.37 → $617 → **$309** | 457.87 → $458 → **$229** |
| archer | 240 | 20 | 110 | 1.2 | 7 | 431.67 → $432 → **$216** | 561.17 → $562 → **$281** | 755.42 → $756 → **$378** | 561.17 → $562 → **$281** |
| runner | 480 | 24 | 20 | 2.6 | 6 | 524.02 → $525 → **$263** | 681.23 → $682 → **$341** | 917.04 → $918 → **$459** | 681.23 → $682 → **$341** |
| brute | 1100 | 32 | 20 | 0.9 | 11 | 525.25 → $526 → **$263** | 682.83 → $683 → **$342** | 919.19 → $920 → **$460** | 682.83 → $683 → **$342** |
| medic | 300 | 0 (heal 60, reach 60) | 20 | 1.4 | 7 | 495.08 → $496 → **$248** | 495.08 → $496 → **$248** | 495.08 → $496 → **$248** | 495.08 → $496 → **$248** |

The medic ignores its element, so every column is the same price.

Factories:

| Factory | Kind | Element | HP | Interval | E | Body raw | Body | Production | **Cost** |
|---|---|---|---|---|---|---|---|---|---|
| Cheapest legal factory | grunt | normal | 120 | 1200 | 5 | 110.6 | $111 | 5 × $177 = $885 | **$996** |
| Slow Factory | grunt | normal | 360 | 1200 | 5 | 246.2 | $247 | 5 × $177 = $885 | **$1,132** |
| Basic Factory (template) | grunt | normal | 360 | 600 | 11 | 246.2 | $247 | 11 × $177 = $1,947 | **$2,194** |
| Swarm Factory | grunt | normal | 360 | 300 | 12 | 246.2 | $247 | 12 × $177 = $2,124 | **$2,371** |
| Armoured Factory | grunt | normal | 720 | 300 | 12 | 539.6 | $540 | 12 × $177 = $2,124 | **$2,664** |
| Fortress Factory | grunt | normal | 1200 | 1200 | 5 | 1250 | $1,250 | 5 × $177 = $885 | **$2,135** |
| Maxed grunt factory | grunt | normal | 1200 | 300 | 12 | 1250 | $1,250 | 12 × $177 = $2,124 | **$3,374**, rejected |
| Archer Nest | archer | normal | 360 | 300 | 12 | 246.2 | $247 | 12 × $216 = $2,592 | **$2,839** |
| Runner Rush | runner | normal | 360 | 720 | 9 | 246.2 | $247 | 9 × $263 = $2,367 | **$2,614** |
| Brute Forge | brute | normal | 360 | 720 | 9 | 246.2 | $247 | 9 × $263 = $2,367 | **$2,614** |
| Steady Factory | grunt | normal | 360 | 900 | 7 | 246.2 | $247 | 7 × $177 = $1,239 | **$1,486** |
| Ice Archer Nest | archer | ice | 360 | 900 | 7 | 246.2 | $247 | 7 × $378 = $2,646 | **$2,893** |
| Fire Brute Pack | brute | fire | 360 | 900 | 7 | 246.2 | $247 | 7 × $342 = $2,394 | **$2,641** |
| Storm Runners | runner | lightning | 360 | 900 | 7 | 246.2 | $247 | 7 × $341 = $2,387 | **$2,634** |
| Fire Grunts | grunt | fire | 360 | 600 | 11 | 246.2 | $247 | 11 × $229 = $2,519 | **$2,766** |
| Medic Tent | medic | normal | 360 | 600 | 11 | 246.2 | $247 | 11 × $248 = $2,728 | **$2,975** |
| Steady Medics | medic | normal | 360 | 900 | 7 | 246.2 | $247 | 7 × $248 = $1,736 | **$1,983** |
| Brute Forge at 300 | brute | normal | 360 | 300 | 12 | 246.2 | $247 | 12 × $263 = $3,156 | **$3,403**, rejected |
| Maxed storm-runner factory | runner | lightning | 1200 | 300 | 12 | 1250 | $1,250 | 12 × $341 = $4,092 | **$5,342**, rejected |

E = min(12, floor(7199 / interval)): 300-599 → 12, 600 → 11, 720 → 9, 900 → 7, 1200 → 5. `burst` still never changes a price.

