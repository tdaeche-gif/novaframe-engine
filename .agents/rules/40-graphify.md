---
trigger: always_on
description: Mandatory Graphify knowledge graph query and update protocol
---

# Graphify Protocol
1. When `graphify-out/graph.json` exists, ALWAYS query the graph before blind file-reading:
   - Architecture & concepts: `graphify query "<question>"`
   - Dependency tracing: `graphify path "<SourceFile>" "<TargetFile>"`
   - Deep module explanation: `graphify explain "<concept>"`
2. AFTER creating, deleting, or modifying code files, update the AST graph:
   - Run `graphify update .` (fast, deterministic, consumes 0 LLM tokens).
