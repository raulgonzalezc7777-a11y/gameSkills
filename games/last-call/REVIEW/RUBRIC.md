# LAST CALL — Visual Review Rubric

The bar is a current-generation AAA fighting game: EA's UFC series, Tekken 8,
Street Fighter 6. A reviewer's job is not to be encouraging. It is to find the
specific thing that gives the frame away as a browser demo and to name it.

## How a review is run

1. Capture the scripted shot list: `node tools/shotlist.mjs REVIEW/shots/<run> <prefix>`.
   Eight beats, from establishing wide to the knockout.
2. Score every beat against the axes below. A beat scores the LOWEST of its axes,
   not the average: one broken element ruins a frame.
3. Where a blind A/B composite is supplied, state which side is better and why
   BEFORE being told which build is which.
4. Produce a findings list. Every finding names a file and a concrete change.

## Reference honesty

No copyrighted reference frames from UFC or any other shipped title exist in
this environment, and none are fetched. A reviewer therefore compares against
two things: this written rubric, which encodes what a current-gen fighter frame
actually contains, and a blind A/B against the previous iteration of this game,
which guarantees quality only ever moves forward. A reviewer must never claim to
have compared against a shipped title's actual pixels.

## Scoring axes, 1 to 10

**1. Lighting and shadow.** Does light come from somewhere and fall off
correctly? Are there contact shadows where a foot meets the floor, where an arm
crosses the torso, where a stool meets the ground? Is there bounce, or is
everything in shadow pure black? Are the highlights shaped by the light sources
in the room? A 10 has a deliberate key/fill/rim design and shadows that tie
every object to the ground. A 3 has ambient light and one directional.

**2. Materials.** Can you tell skin from cotton from denim from lacquered wood
from brushed steel from glass, with the colour removed? Each needs its own
roughness response, normal detail and specular behaviour. Flat untextured
polygons are an automatic fail. A 10 has micro-detail visible at gameplay
distance and materials that change convincingly with viewing angle.

**3. Characters.** Silhouette first: is the figure instantly readable as a
specific person at 4 metres? Then anatomy: do joints deform or separate, do
proportions hold, does the head read as a head. Then detail: hands, face,
clothing that drapes rather than floats. Primitives visibly glued together are
an automatic fail.

**4. Animation and weight.** Does the body have mass? Feet planted, no sliding,
no floating. Anticipation before an attack, follow-through after. Secondary
motion in the spine and head. Impacts that transfer force into the receiver. A
10 makes you feel the punch. A 3 is a T-pose that slides.

**5. Composition and camera.** Is the frame composed, or is the camera just
behind the player? Depth layers (foreground, subject, midground, background),
leading room, both fighters readable, dynamic framing that reacts to the action.
Camera movement that has inertia rather than snapping.

**6. Effects and feedback.** Does a hit produce a layered response: impact
flash, particles, camera shake, hit-stop, audio, a reaction on the receiver? Are
particles lit and soft, or flat additive dots? Do effects respect depth?

**7. Environment and world-building.** Does the venue read as a real place with
a history, or as a stage? Props with purpose, wear and grime, architecture with
depth, a background that recedes. Is the space believable at the edges of frame?

**8. Post processing and grade.** A deliberate colour grade rather than raw
output. Bloom that comes from actual bright sources, not a haze over everything.
Real depth of field with a focal plane that tracks the action. Grain and
aberration used as cinematic seasoning, never as a mask for missing detail.
Highlights that roll off instead of clipping to white.

**9. UI and presentation.** Typography with hierarchy and confidence, animation
on state changes, layout that frames the action rather than crowding it, a
visual language consistent with the world.

**10. Cohesion.** Do all of the above look like one art direction by one team,
or like nine separate systems in one scene? This axis catches the thing that
individual reviews miss.

## Hard fails, regardless of other scores

- Any `[pageerror]` in the capture log.
- A black or near-black frame, or a frame where the subject is unreadable.
- Visible default Three.js look: `MeshBasicMaterial` flat colour, untextured
  primitives, the default grid, `MeshNormalMaterial` rainbow.
- Z-fighting, geometry interpenetration on a character, inverted normals.
- Clipped highlights covering more than a small fraction of the frame.
- Text that is illegible at 1600x900.

## The verdict

A build PASSES only when every beat scores 8 or above on every axis and there
are zero hard fails. Anything else is a FAIL with a numbered findings list, and
the loop runs again.
