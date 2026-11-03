# Ownership and handoffs

- Delegate bounded eligible work when tools and policy permit. If required delegation is
  unavailable, ask before doing it directly. The parent owns decisions and final acceptance.
- Allow one writer per checkout. Check cross-session ownership and process evidence before
  assigning another; an empty task list does not prove an earlier writer exited.
- Use separate worktrees for parallel writers and read-only independent reviewers. Give each
  worker a goal, baseline, allowed edits, contracts, checks, stop conditions and handoff path.
- Keep substantial implementation and independent review separate. Review findings are
  preliminary; the parent reads artifacts, resolves contradictions and reruns affected checks.
- Store approved plans durably. Include scope, prerequisites, decisions, sequence, failure
  cases, acceptance and stop conditions. Record each task's implementation, files/contracts,
  checks, limits and next task directly below it when the plan format supports that.
- Before timeout, record changed files, unfinished work, checks, owned processes/resources,
  cleanup and next task. Treat cancellations, crashes and missing handoffs as incomplete.
  Confirm the previous writer exited before retrying; never silently switch execution modes.
- Stop only owned browsers/servers with supported cleanup. Direct process termination needs
  explicit authority and a fresh identity check; never terminate unrelated processes.
