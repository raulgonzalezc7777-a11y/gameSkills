# LAST CALL — Game Design

A third-person party brawler set in EL GARITO, a dive bar at closing time. Two
to four fighters, increasingly drunk, settle it on the dance floor while the
crowd films it. The fantasy is a bar fight that everyone will laugh about
tomorrow, fought with the mechanical depth of a real fighting game.

## The one idea

**Drunkenness is the resource, the risk and the joke.** It is not a status
effect you avoid. It is the meter you spend the whole match managing, and the
reason every round is different.

Drinking (E, or grabbing a bottle off the bar) raises your BUZZ:

| Buzz | Power | Accuracy | Balance | Pain tolerance | Crowd hype |
|------|-------|----------|---------|----------------|------------|
| 0-25   Sober   | baseline | perfect | perfect | baseline | bored |
| 25-50  Loose   | +15% | -8% | slight sway | +8% | warming |
| 50-72  Lit     | +32% | -22% | visible sway, wide guard | +16% | loud |
| 72-90  Wasted  | +45% | -34% | stumbles, delayed footing | +22% | roaring |
| 90-100 Legless | +55% | -42% | falls over on a whiff | +28% | ecstatic |

Buzz decays slowly, and every hit you take burns a little of it off. So the
skill is riding the line: drunk enough to hit like a truck and thrill the
crowd, sober enough to actually connect.

## Systems that make it stick

**Hype and the Borrachera.** The crowd has a HYPE meter fed by flashy play:
combos, counters, high-buzz knockdowns, breaking props, taunting at the right
moment. Full hype unlocks BORRACHERA, a cinematic super where the screen tilts,
the music ducks, and your fighter does something no sober person would attempt.
Hype is spent, so the choice is: cash it now for damage, or hold it for the
comeback.

**Last Call.** When the round clock passes 20 seconds the bar calls last call:
the lights go strobe, the music doubles, every fighter is handed a drink
(forced +20 buzz), and damage is multiplied. Every round ends in chaos, by
design. This is the hook that makes the final 20 seconds the best part.

**Props are the arena.** Bottles, stools, glasses, the jukebox. Grab (G) picks
up whatever is in reach; the same button throws it. Props break, produce glass,
cut the target, and feed hype. The bar restocks, so there is always something
to swing.

**The stumble-dodge.** At high buzz your fighter randomly lurches. A lurch that
happens to dodge an attack is scored as a DRUNKEN GRACE: free hype, a slow-mo
beat, and the crowd loses it. You cannot aim it. That is the point: the game
rewards you for a thing you did not earn, which is exactly how a bar fight
feels.

**Per-limb damage.** Head, body and legs take damage independently, UFC style.
A battered head means flash knockdowns. A battered body drains stamina faster.
Battered legs cut your movement speed and make the drunk sway worse. Targeting
is the depth under the comedy.

## Controls

| Action | Key | Notes |
|---|---|---|
| Move | WASD | relative to your fighter's facing |
| Sprint | Shift | costs stamina |
| Jab | J / LMB | fast, low damage, chains into everything |
| Cross | K | the workhorse |
| Hook | U | wide, high damage, punishable |
| Uppercut | I | slow, launches, the knockdown tool |
| Body kick | L | reaches furthest, hits the body |
| Block | Space / RMB | bleeds stamina, reduces damage by 78% |
| Dodge | C | i-frames, costs stamina |
| Grapple / grab prop | G | clinch, or pick up what is in reach |
| Drink | E | +14 buzz, +18 stamina, +4 health, leaves you open |
| Taunt | T | hype, but a free hit for the opponent |
| Borrachera | F | at full hype only |

## Combo system

Attacks chain inside a 0.28 s buffer window. Chains are not fixed strings: any
attack can follow any other, but each link costs more stamina and the accuracy
penalty compounds, so a nine-hit drunk combo is possible and almost always a
terrible idea. Counters (hitting during an opponent's startup frames) deal 1.6x
and reset the chain cost. Parry (block within 0.12 s of contact) stuns and
gives a free chain.

## Match structure

Three rounds, 99 seconds each. A round ends on KO, on a 10-count after a third
knockdown, or on the clock with the higher remaining health winning. Between
rounds the bar restocks, buzz carries over at 60%, and health partially
recovers. Best of three takes the night.

## Modes

- **Brawl** — one versus one against the AI, the main mode.
- **Party** — up to four fighters, free-for-all, last one standing.
- **Lock-in** — an endurance run against the full roster on one health bar.
