# Preflight LLD

Current prototype versus target design. Prose is short. The diagrams carry the constructs.

## Architecture

Current is a stateless pipeline. Post adds application services, domain objects, and ports. Settings enter as a plain `Config` object at activation. There is no `SettingsService`.

```mermaid
flowchart TB
  subgraph Current
    P1[Panel] --> A1[analyze]
    P1 --> R1[review]
    A1 --> W1[workspace.notes]
    R1 --> C1[Claude CLI]
    P1 --> S1[send]
    P1 --> L1[study log]
  end
  subgraph Post
    P2[Panel] --> PS[PromptService]
    P2 --> FS[FeedbackService]
    P2 --> SS[SessionService]
    FS --> RE[RuleEngine]
    FS --> CA[ContextAssembler]
    FS --> DP[buildDeepPrompt]
    FS --> IF[InstructionLoader]
    FS --> MP[ModelProvider]
    SS --> GP[GatePolicy]
    PS --> DR[DraftRepository]
    SS --> SR[SessionRepository]
    CA --> WS[Workspace and language sources]
    CA --> SL[SessionSliceReader]
    MP --> CLI[Claude Code and Codex CLI]
  end
```

## Objects

Current keeps state in the panel. Post persists the draft, session, bundle, reports, and send record.

```mermaid
flowchart LR
  subgraph Current
    panel1["panel1: PanelState"] --> analysis1["analysis1: Analysis"]
    panel1 --> review1["review1: Review"]
    analysis1 --> workspace1["workspace1: WorkspaceContext"]
    review1 --> workspace1
  end
  subgraph Post
    draft1["draft1: PromptDraft"] --> session1["session1: FeedbackSession"]
    session1 --> question1["question1: Question"]
    session1 --> quick1["quick1: QuickReview"]
    session1 --> deep1["deep1: DeepReview"]
    bundle1["bundle1: ContextBundle"] --> draft1
    bundle1 --> question1
    bundle1 --> fragment1["fragment1: ContextFragment"]
    bundle1 --> slice1["slice1: SessionSlice"]
    bundle1 --> manifest1["manifest1: ContextManifest"]
    quick1 --> rule1["rule1: RuleReport"]
    quick1 --> score1["score1: ScoreReport"]
    deep1 --> rule1
    deep1 --> score1
    deep1 --> manifest1
    deep1 --> profile1["profile1: ModelProfile"]
    quick1 -.-> error1["error1: FeedbackError"]
    deep1 -.-> error1
    send1["send1: SendRecord"] --> draft1
    send1 --> session1
  end
```

## Sequence

Current reviews, then gates on the rule score. Post assembles context, reviews deeply, then applies one gate policy to a fresh score.

```mermaid
sequenceDiagram
  participant U as User
  participant P as Panel
  participant A as analyze
  participant R as review
  participant C as Claude
  participant F as FeedbackService
  participant X as ContextAssembler
  participant D as buildDeepPrompt
  participant I as Instruction files
  participant M as ModelProvider
  participant G as GatePolicy
  participant S as SessionService
  rect rgb(245,245,245)
    Note over U,C: Current
    U->>P: type draft
    P->>A: analyze(draft, workspace)
    A-->>P: Analysis and score
    P->>R: review(draft, mode, notes)
    R->>C: claude -p
    C-->>R: Review JSON
    R-->>P: Review
    U->>P: Send
    P->>P: gate on rule score
  end
  rect rgb(235,245,255)
    Note over U,S: Post
    U->>P: type draft
    P->>F: quick(draft)
    F->>F: RuleEngine
    F->>M: complete(draft, rubric)
    M-->>F: QuickReview and ScoreReport
    F-->>P: render
    U->>P: deep(draft, answers)
    P->>F: deep(draft, answers)
    alt supports instruction files
      F->>I: load(draft)
      I-->>F: block and files
    end
    F->>X: build(draft, answers, files)
    X-->>F: ContextBundle and Manifest
    F->>D: buildDeepPrompt(bundle, block)
    D-->>F: system and user
    F->>M: complete(system, user)
    M-->>F: DeepReview
    F->>S: save(review)
    F-->>P: render
    U->>P: Send
    P->>S: send(draft)
    S->>F: quick(draft) when stale
    F-->>S: ScoreReport or null
    S->>G: decide(rule, score, settings)
    G-->>S: allow or confirm
    S-->>P: SendRecord
  end
```

## Activity

Current is linear. Post adds a context loop, an answer loop, and a fresh-score step.

```mermaid
flowchart TB
  subgraph Current
    C0([Type draft]) --> C1[Analyze]
    C1 --> C2[Show score and findings]
    C2 --> C3[Review]
    C3 --> C4[Render issues]
    C4 --> C5{Rule score low?}
    C5 -- yes --> C6[Confirm]
    C5 -- no --> C7[Send]
    C6 --> C7
  end
  subgraph Post
    P0([Type draft]) --> P1[RuleEngine]
    P1 --> P2[Quick review]
    P2 --> P3[ScoreReport]
    P3 --> P4{Deep feedback?}
    P4 -- yes --> P5[ContextAssembler]
    P5 --> P6[ContextBundle and Manifest]
    P6 --> P7[ModelProvider.deep]
    P7 --> P8[DeepReview]
    P8 --> P9{Questions?}
    P9 -- yes --> P10[Answer]
    P10 --> P5
    P9 -- no --> P11{Gate sending?}
    P4 -- no --> P11
    P11 -- no --> P12[SendRecord]
    P11 -- yes --> P14[Fresh score or 8s quick]
    P14 --> P15{GatePolicy}
    P15 -- allow --> P12
    P15 -- confirm --> P13[Confirm]
    P13 --> P12
  end
```
