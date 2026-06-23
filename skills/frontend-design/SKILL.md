---
name: frontend-design
description: Distinctive, intentional UI design — palette, typography, layout, and copy that read as deliberate choices for this brief, not templated defaults. Load before building or reshaping any user-facing UI.
---

# Frontend Design

Work like the design lead at a studio that gives every product an identity no one would mistake for
anyone else's. The bar is: deliberate, opinionated choices specific to *this* brief, plus one real
aesthetic risk you can justify. A correct-but-templated screen fails the bar.

## Ground it in the subject

If the brief doesn't pin down what the product is, pin it yourself before designing: name the subject,
its audience, and the page's single job — and state that choice. Distinctive choices come from the
subject's own world (its materials, vocabulary, artifacts), so build with the real content throughout,
not lorem ipsum. If you know the user's preferences or past work, use them as a hint.

## Principles

- **The hero is a thesis.** Open with the most characteristic thing in the subject's world, in whatever
  form fits (headline, image, live demo, motion). "Big number + label + gradient accent" is the
  template answer — use it only if it's genuinely best.
- **Typography carries personality.** Pair display and body faces deliberately (not your default
  go-tos), set an intentional type scale with real weight/width/spacing contrast. Make the type
  treatment itself memorable, not a neutral delivery vehicle.
- **Structure encodes meaning.** Numbering, eyebrows, dividers, labels should say something true about
  the content. Numbered markers (01/02/03) belong only when the content really is a sequence.
- **Motion is deliberate.** One orchestrated moment usually beats scattered effects. Excess animation
  is itself a tell of AI-generated work — sometimes less is more.
- **Match complexity to the vision.** Maximalist needs elaborate execution; minimal needs precision in
  spacing, type, and detail. Elegance is executing the chosen vision well.

## Avoid the AI-default look

Current AI design clusters on three looks — recognize and avoid them unless the brief asks for one:
(1) warm cream bg (~#F4F1EA) + high-contrast serif + terracotta accent; (2) near-black bg + one acid
green/vermilion accent; (3) broadsheet layout, hairline rules, zero radius, dense columns. They appear
regardless of subject — that's what makes them defaults. Where the brief frees an axis, don't spend
that freedom on a default. Where the brief pins a direction, follow it exactly — the brief's words win.

## Process: plan → critique → build → critique

1. **Token plan first.** Color: 4–6 named hex values. Type: 2+ roles (characterful display used with
   restraint, a body face, a utility face for data/captions). Layout: a concept in one-sentence prose
   + an ASCII wireframe. Signature: the single element this page is remembered by.
2. **Critique the plan against the brief** before writing code. If any part reads like the generic
   default you'd produce for any similar page, revise it and say what changed and why.
3. **Build to the plan**, deriving every color/type decision from the tokens. Watch CSS specificity —
   type-based (`.section`) vs element-based selectors silently cancel each other's padding/margins.
4. **Critique again.** If your environment can screenshot the result (`run_bash`), look — a picture is
   worth 1000 tokens. Spend boldness in one place; keep everything around the signature quiet.

## Quality floor (non-negotiable, never announced)

Responsive down to mobile. Visible keyboard focus. `prefers-reduced-motion` respected. Sufficient color
contrast. Semantic HTML, no dead markup.

## Copy is design material

Words exist to make the UI easier to understand, so bring the same intent as to spacing and color.
Write from the user's side of the screen ("manage notifications", not "webhook config"). Active voice
that says what happens: "Save changes", not "Submit" — and keep the verb consistent through the flow
(a "Publish" button yields a "Published" toast). Errors explain what went wrong and how to fix it,
in the interface's voice; an empty state is an invitation to act. Sentence case, plain verbs, no filler.
