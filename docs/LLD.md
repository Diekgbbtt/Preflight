# Preflight LLD

One VS Code extension. Five layers. Ports at every seam.

```mermaid
flowchart TB
  subgraph P[Presentation]
    Panel[Panel controller<br/>typed protocol]
  end
  subgraph A[Application]
    Prompt[PromptService]
    Feedback[FeedbackService]
    Rules[RuleEngine]
    Context[ContextAssembler]
    Gate[GatePolicy]
    Session[SessionService]
  end
  subgraph D[Domain]
    Draft[PromptDraft · Question]
    Bundle[ContextBundle · Manifest]
    Reports[RuleReport · ScoreReport<br/>QuickReview · DeepReview]
    Send[FeedbackSession · SendRecord]
  end
  subgraph I[Infrastructure]
    Repo[JSONL repositories]
    Sources[Workspace and language sources]
    Slice[SessionSliceReader]
    Model[ModelProvider adapter]
  end
  subgraph Plat[Platform]
    VSCode[VS Code API]
    CLI[Claude Code and Codex CLI]
  end

  Panel --> Prompt
  Panel --> Feedback
  Panel --> Session
  Prompt --> Draft
  Prompt --> Repo
  Feedback --> Rules
  Feedback --> Context
  Feedback --> Model
  Feedback --> Reports
  Rules --> Reports
  Context --> Bundle
  Context --> Sources
  Context --> Slice
  Session --> Send
  Session --> Repo
  Session --> Slice
  Session --> Gate
  Gate --> Reports
  Sources --> VSCode
  Slice --> VSCode
  Model --> CLI
```

## Constructs

| Construct | Responsibility |
|---|---|
| Panel | Draft, view state, typed messages |
| PromptService | Draft lifecycle and restore |
| FeedbackService | Quick and deep review orchestration |
| RuleEngine | Instant symbolic findings |
| ContextAssembler | Bounded bundle and manifest |
| GatePolicy | Pure send decision |
| SessionService | Sessions, answers, send records |
| Repositories | JSONL append and snapshot |
| ModelProvider | Provider, model, effort, completion |
| Sources and SliceReader | Workspace, language, git, current session |

## Rules

- Dependencies point down. Domain imports nothing.
- Application uses ports. Infrastructure implements them.
- `core/` has no VS Code imports.
- Invalid model output yields no score, no crash, no gate.
- `gateSending` defaults false.
- Deep feedback receives draft, answers, workspace, and a bounded current-session slice.

## Core flow

```text
FeedbackService.deep(draft, answers)
  ContextAssembler.build -> ContextBundle + ContextManifest
  ModelProvider.complete(bundle) -> DeepReview + ScoreReport
  SessionService.save(review)
  GatePolicy.decide(ruleReport, scoreReport, settings)
```
