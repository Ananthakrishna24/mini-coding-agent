---
name: design-thinking
description: UX and product reasoning — frame the real problem and user before jumping to solutions, diverge then converge, validate against the user not your taste. Load for feature/flow/product decisions, not pure visual styling.
---

# Design Thinking

For product and UX decisions — *what* to build and *why*, before *how it looks* (that's
[frontend-design]). The failure mode this guards against: jumping to a solution before the real problem
and the real user are pinned down. Move through the phases, but loop back when evidence says to.

## 1. Frame the problem (before any solution)

- **Name the user and their job-to-be-done.** Who is this for, and what are they trying to accomplish
  in their own terms? "A user wants a dashboard" is a solution in disguise — the job is "know at a
  glance whether anything needs my attention."
- **State the problem as a need, not a feature.** "People miss critical alerts" beats "add a
  notifications panel." The need admits many solutions; the feature pre-commits to one.
- **Surface assumptions and constraints.** What are you assuming is true? What's fixed (platform,
  timeline, existing patterns)? Write them down so they're challengeable, not silent.

## 2. Diverge, then converge

- **Generate several distinct approaches** before judging any. The first idea is rarely the best; if
  every option is a variant of one idea, you haven't diverged.
- **Then converge on evidence**, not on whoever spoke loudest or on your own taste. Pick the approach
  that best serves the job-to-be-done at acceptable cost, and name the tradeoff you accepted.

## 3. Prototype the cheapest thing that tests the risk

Build the smallest artifact that answers the riskiest open question — a sketch, a flow, a fake-door, a
rough working slice. The goal is to *learn*, not to ship. Prototype the part most likely to be wrong,
not the part easiest to build.

## 4. Validate against the user

- **Test the job, not the UI.** Can a real (or representative) user accomplish the job-to-be-done
  without you narrating? Watch what they do, not what they say they'd do.
- **A failed test is a success** — it bought you the redesign cheaply. Loop back to the phase the
  evidence points at (often reframing the problem), don't patch around the finding.

## UX heuristics to check against (Nielsen, abbreviated)

- **Visibility of system status** — the UI always shows what's happening (loading, saved, error).
- **Match the user's world** — real-world language and order, not system internals.
- **User control** — clear exits, undo, no dead ends.
- **Consistency** — same word/action means the same thing everywhere; follow platform conventions.
- **Error prevention** > error messages — make the bad state hard to reach in the first place.
- **Recognition over recall** — show options; don't make people remember them.
- **Flexibility** — accelerators for experts, sane defaults for newcomers.
- **Minimalist** — every extra element competes with the relevant ones; cut what doesn't serve the job.
- **Good errors** — plain language, name the problem, offer the fix.
- **Help** — needed help is findable and task-focused; the best help is a UI that doesn't need it.

## Accessibility is part of the job, not a pass

Keyboard-operable, screen-reader-labeled, sufficient contrast, not color-alone for meaning, respects
reduced-motion. Designing the happy path only is an unfinished design.
