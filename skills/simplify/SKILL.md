---
name: simplify
description: Review changed code for reuse, quality, and efficiency, and fix any issues found. Use when completing a task or after making significant edits to clean up code duplication, redundant state, or performance bottlenecks.
---

# Simplify: Code Review and Cleanup

Review all changed files for reuse, quality, and efficiency. Fix any issues found.

## Phase 1: Identify Changes

Run `git diff` (or `git diff HEAD` if there are staged changes) to see what changed. If there are no git changes, review the most recently modified files that the user mentioned or that you edited earlier in this conversation.

## Phase 2: Code Review

Review the changes for the following areas:

### 1. Code Reuse
- **Search for existing utilities and helpers** that could replace newly written code. Look for similar patterns elsewhere in the codebase.
- **Flag any new function that duplicates existing functionality.**
- **Flag any inline logic that could use an existing utility** (string manipulation, path handling, type guards).

### 2. Code Quality
- **Redundant state**: state that duplicates existing state, cached values that could be derived, observers/effects that could be direct calls.
- **Parameter sprawl**: adding new parameters to a function instead of generalizing or restructuring existing ones.
- **Copy-paste with slight variation**: near-duplicate code blocks that should be unified with a shared abstraction.
- **Leaky abstractions**: exposing internal details that should be encapsulated.
- **Stringly-typed code**: using raw strings where constants, enums, or string unions already exist.

### 3. Efficiency
- **Unnecessary work**: redundant computations, repeated file reads, duplicate network calls, N+1 patterns.
- **Missed concurrency**: independent operations run sequentially when they could run in parallel.
- **Hot-path bloat**: new blocking work added to startup or request hot paths.
- **Recurring no-op updates**: state/store updates inside polling loops or event handlers that fire unconditionally.

## Phase 3: Fix Issues

Identify areas to improve, aggregate findings, and fix each issue directly. When done, briefly summarize what was fixed.
