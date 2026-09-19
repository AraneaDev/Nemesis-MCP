## Nemesis-MCP

> *"Een stub voor een methode die allang niet meer bestaat, slaagt ook."*

Nemesis-MCP is an inspection tool designed to verify contract integrity between test doubles (mocks, stubs, spies) and production code across multi-language repositories. It intercepts the most insidious failure mode of LLM-generated tests: **the permanently green test suite guarding phantom code**.

---

### Core Philosophy & Problem Statement

When an AI agent modifies an implementation signature, interface, or return type, traditional test suites fail in one of two ways:

1. **The suite breaks loudly** (integration or strict contract tests catch it).
2. **The suite stays green silently** because unit tests mock the modified boundary with outdated signatures, fictitious arguments, or obsolete return types.

Coding agents lean heavily on unit tests with mocks to reach a "passing" state quickly. Nemesis-MCP performs static AST extraction of test doubles and checks them against the concrete definitions (classes, interfaces, types) in the production codebase.

---

### Supported Ecosystems & Mocking Patterns

Nemesis targets the core quartet (TypeScript/JavaScript, PHP, Python, and Rust).

| Ecosystem | Test Frameworks | Mocking Patterns Detected |
| --- | --- | --- |
| **PHP** | PHPUnit, Pest, Mockery | `createMock()`, `$this->mock()`, `Mockery::mock()`, `expects()->method('name')`, `willReturn()` |
| **TypeScript / JS** | Vitest, Jest | `vi.spyOn(obj, 'method')`, `jest.spyOn()`, `vi.fn()`, `mockReturnValue()`, inline interface stubs |
| **Python** | pytest-mock, unittest.mock | `mocker.patch.object()`, `create_autospec()`, `MagicMock(spec=...)`, manual fixture stubs |
| **Rust** | mockall, mockiato | `mock!`, `#[automock]`, contract verification for trait implementations |

---

### Architecture & Pipeline

```
┌─────────────────────┐       ┌──────────────────────┐
│   Test AST Parser   │       │ Production AST Index │
│  (Finds Doubles)    │       │ (Types & Signatures) │
└──────────┬──────────┘       └──────────┬───────────┘
           │                             │
           ▼                             ▼
   Double Manifest               Symbol Manifest
   - Target symbol/method        - Method signature
   - Argument count/types        - Parameter types & defaults
   - Mocked return type          - Concrete return type
           │                             │
           └──────────────┬──────────────┘
                          ▼
           ┌─────────────────────────────┐
           │     Drift Analyzer Engine   │
           │  (Detects 4 Core Violations)│
           └──────────────┬──────────────┘
                          ▼
             JSON / MCP Protocol Output

```

1. **Production Indexer**: Extracts public APIs (interfaces, classes, traits, functions, type definitions) into an in-memory symbol graph using Tree-sitter AST queries.
2. **Double Extractor**: Traverses test files to identify where mocks/stubs are initialized, which methods are being stubbed, and what return/argument constraints are set.
3. **Drift Analyzer**: Resolves each double against the production symbol graph and classifies divergences into four distinct violation types.

---

### The Four Contract Violations

Nemesis evaluates doubles against four specific failure criteria:

* **Ghost Methods (`GHOST_METHOD`)**: The test mocks or stubs a method name that does not exist on the target class, interface, or trait (e.g., method was renamed or deleted).
* **Arity Mismatch (`ARITY_MISMATCH`)**: The test configures `with($a, $b)` or passes arguments to a stub that exceed the method's parameters or omit non-default required parameters.
* **Return Type Drift (`RETURN_DRIFT`)**: The stub specifies a return value (`willReturn('string')`) that violates the declared return type (`: int` or `Promise<User>`) of the real method.
* **Visibility Breach (`VISIBILITY_BREACH`)**: The test stubs a `private` or `protected` method directly, bypassing the intended public interface.

---

### MCP Interface & Tools

Nemesis exposes three lightweight MCP tools designed for fast execution before merging or running pre-commit checks:

#### 1. `nemesis_audit`

Scans the entire repository or a designated directory for double drift.

* **Parameters:**
* `paths` (array of strings, optional): Specific test files or directories to inspect. Defaults to standard test directories (`tests/`, `__tests__/`, `src/**/*.spec.ts`).
* `strictness` (string: `"all"` | `"untyped_only"` | `"breaking_only"`): Filter by severity.


* **Response:**
```json
{
  "summary": {
    "scanned_test_files": 42,
    "doubles_inspected": 187,
    "violations_count": 3
  },
  "violations": [
    {
      "file": "tests/Unit/Services/BillingServiceTest.php",
      "line": 54,
      "type": "GHOST_METHOD",
      "double_type": "PHPUnit_MockObject",
      "target": "App\\Contracts\\PaymentGateway::chargeToken",
      "message": "Method 'chargeToken' does not exist on 'App\\Contracts\\PaymentGateway'. Did you mean 'chargeWithToken'?"
    },
    {
      "file": "tests/components/UserAvatar.spec.ts",
      "line": 28,
      "type": "RETURN_DRIFT",
      "double_type": "vi.spyOn",
      "target": "UserService.getProfile",
      "message": "Stub returns '{ id: string }' but UserService.getProfile returns 'Promise<UserProfile>'."
    }
  ]
}

```



#### 2. `nemesis_verify_symbol`

Targeted query used while an agent is modifying a specific file or method.

* **Parameters:**
* `symbol` (string, required): Qualified class, interface, or function name (e.g., `App\Services\InvoiceService` or `AuthClient`).


* **Response:** Returns every test double across the repository pointing to this symbol and flags whether they remain valid after the latest edit.

#### 3. `nemesis_stale_fixtures`

Inspects JSON, YAML, or factory fixtures used in stubs to verify that required schema fields match current model or DTO structures.

---

### CLI & Agent Integration Workflow

In an agent-assisted pipeline, Nemesis-MCP runs in two key slots:

1. **Before Agent Finishes (`nemesis_verify_symbol`)**:
When an agent refactors an interface or service signature, it invokes Nemesis on the modified symbol to immediately identify which unit test doubles need signature updates.
2. **Pre-Merge Audit (`nemesis_audit`)**:
Runs alongside **Chaos-MCP** and **Momus-MCP** in CI or pre-commit hooks. If an agent writes a passing test that asserts against an obsolete method signature, the check fails with an exit code 1.
