# Changelog

## [0.2.1](https://github.com/AraneaDev/Nemesis-MCP/compare/v0.2.0...v0.2.1) (2026-09-20)


### Fixes

* stop counting a vi.mock factory value as a second double ([1cb23f5](https://github.com/AraneaDev/Nemesis-MCP/commit/1cb23f5cda128dd4efe4106902b98ec70b144746))
* stop letting the Python builtin exemption define confidence and swallow real ghosts ([c8c424c](https://github.com/AraneaDev/Nemesis-MCP/commit/c8c424c64cb4ebdd0826a44739cbfd0743cdc25b))
* stop treating a TypeScript import as a re-export ([349730c](https://github.com/AraneaDev/Nemesis-MCP/commit/349730cd3cc5fa0a6fad7a0d95d4220fe04ecd39))
* the same missing factory key was reported twice ([9e3025f](https://github.com/AraneaDev/Nemesis-MCP/commit/9e3025f3bb7e0f1dfd5053c405d162463b105e3f))
* three places the tool was wrong in public ([ec8c537](https://github.com/AraneaDev/Nemesis-MCP/commit/ec8c5373cab90f1526e1b2927e06a5d298a9d979))

## [0.2.0](https://github.com/AraneaDev/Nemesis-MCP/compare/v0.1.0...v0.2.0) (2026-09-20)


### Features

* a Python double that names a module now has something to check ([3ae69ad](https://github.com/AraneaDev/Nemesis-MCP/commit/3ae69ad5f22d5a7d73a2ff69e891beb40b575286))
* a Python file is a symbol with members ([3e875da](https://github.com/AraneaDev/Nemesis-MCP/commit/3e875da22abebfa07715b92b2c0a67870c2212ee))
* a TypeScript or JavaScript file is now a module symbol too ([b5332e4](https://github.com/AraneaDev/Nemesis-MCP/commit/b5332e4b03d474a5b511e664f6a78cb443b61638))
* accessors, unstubbable members, and enum values in fixtures ([014319f](https://github.com/AraneaDev/Nemesis-MCP/commit/014319f46636e5c52512062705428662ab0bbf22))
* an identifier bound to a module names the module ([7f6b4f0](https://github.com/AraneaDev/Nemesis-MCP/commit/7f6b4f09d0a648e04a90df016329bae68482949d))
* an index of modules, and a way to find the one a target names ([8c88cdb](https://github.com/AraneaDev/Nemesis-MCP/commit/8c88cdbb539dc30acfe25a10eda5c4eeb80f0d49))
* ask what a module exports, not what it declares ([d47f473](https://github.com/AraneaDev/Nemesis-MCP/commit/d47f47369c823a0122a17ef30e734a9a2013e94d))
* catch stubs whose contract is about the shape of the call ([a7b6324](https://github.com/AraneaDev/Nemesis-MCP/commit/a7b6324df70aab7d3b6391f144f0edae9706b7b0))
* check argument names, and fixture field types ([061f594](https://github.com/AraneaDev/Nemesis-MCP/commit/061f59486c3a4738cf4bdb4ca0d2d5f842ad1479))
* check literal call arguments against declared parameter types ([ff262a0](https://github.com/AraneaDev/Nemesis-MCP/commit/ff262a08da6f41dd073301d9603dc9cf4744b52d))
* configured mocks, and two PHPUnit factories that produced no doubles ([07db739](https://github.com/AraneaDev/Nemesis-MCP/commit/07db7392469aa8601da11381f76ba0eb6cc70c26))
* count what the analyzer actually reached ([220ed66](https://github.com/AraneaDev/Nemesis-MCP/commit/220ed66dbfcf9062e25b3f565691ab9e5a81a949))
* detect field-level drift, mockall return values, and untracked members ([5840d73](https://github.com/AraneaDev/Nemesis-MCP/commit/5840d7355ad1740b085a8f32a2d31f39eb4dae5d))
* doubles for classes that are gone, and fakes that kept a dropped parameter ([895c0b7](https://github.com/AraneaDev/Nemesis-MCP/commit/895c0b758e4460395595026aebdf9440e7dc0af9))
* fixtures check the objects inside the objects ([60f9f80](https://github.com/AraneaDev/Nemesis-MCP/commit/60f9f801313e02e01a9d6b37a5783591a0b1f755))
* literal union types, and mock! blocks that never worked ([15cfc8a](https://github.com/AraneaDev/Nemesis-MCP/commit/15cfc8a6a45ae305766c42fcde96f647f25f54ed))
* manual mocks in __mocks__, and every keyword of patch.multiple ([6ace0c6](https://github.com/AraneaDev/Nemesis-MCP/commit/6ace0c60b985d410c8141a0c4cfe6c59724deee7))
* nemesis-mcp v0.1 — static contract inspection between test doubles and production code ([af70101](https://github.com/AraneaDev/Nemesis-MCP/commit/af7010171fdcbae3523a668dbf3fffcbcc34ebbc))
* partial mocks name their members, and PHP magic methods answer for theirs ([3ad6046](https://github.com/AraneaDev/Nemesis-MCP/commit/3ad604699395349127932c2149868a5fe5da7451))
* rejecting is a promise too, and mockReturnThis is a fluency claim ([7868400](https://github.com/AraneaDev/Nemesis-MCP/commit/7868400d94861f4e2cb2ac9186cc307a1c4e9309))
* report doubles that cannot exist at runtime ([8356060](https://github.com/AraneaDev/Nemesis-MCP/commit/8356060689ad6fd77dc3b89ecd91fd875142fc33))
* resolve doubles against module members ([306c6ff](https://github.com/AraneaDev/Nemesis-MCP/commit/306c6ff883879f3a0e5f9eb233af2ccc4023fe82))
* scan budgets, multi-language fixture matrix, and dogfood hardening ([5a766df](https://github.com/AraneaDev/Nemesis-MCP/commit/5a766df6018ac7fa7399f3540e472fb7072c3d7d))
* the summary says how much of the scan it compared ([e40f7ad](https://github.com/AraneaDev/Nemesis-MCP/commit/e40f7ad8fba5c4f7f689657aaf7f220770aadd90))
* the values a module mock supplies are stubs in their own right ([d519400](https://github.com/AraneaDev/Nemesis-MCP/commit/d5194000fbc432e682af2f4263dbfb3780fafc52))


### Fixes

* a generated file was style-gated, so every release would fail lint ([0be75d9](https://github.com/AraneaDev/Nemesis-MCP/commit/0be75d99ba8b351270c573580ee2bb8eeaec58d2))
* a local binding that shadowed a module import was overruled by it ([137e59a](https://github.com/AraneaDev/Nemesis-MCP/commit/137e59aedc9fbd14e12396d3e38478563e9128b4))
* a module member exists for decorated defs, classes, and assignments ([2432236](https://github.com/AraneaDev/Nemesis-MCP/commit/2432236197b126d4147a255a44d13f2f43e007d2))
* a placeholder was read as a claim, and a type parameter as a type ([e0539d2](https://github.com/AraneaDev/Nemesis-MCP/commit/e0539d26ff5f43fa5c6bc657b6e73d09c0776ff7))
* a Python builtin is a module member even when unbound by the file ([d31ed35](https://github.com/AraneaDev/Nemesis-MCP/commit/d31ed3559c84e9c2354f599df4c5e68ff8621628))
* a Python bytes literal infers as bytes, not string ([7b61660](https://github.com/AraneaDev/Nemesis-MCP/commit/7b61660f61006d71d76c43647737b5b999101388))
* an inherited method's double no longer clears the double that broke it ([2b636f9](https://github.com/AraneaDev/Nemesis-MCP/commit/2b636f9cf03e1085ca7aaeb625c667ada25d5c27))
* count and report must ask the same question about module mocks ([a9254cc](https://github.com/AraneaDev/Nemesis-MCP/commit/a9254cc6c97689cf59077801bc1e0bb560cd38ce))
* enum values in stubs, and Python properties ([c5dfa11](https://github.com/AraneaDev/Nemesis-MCP/commit/c5dfa112b68cc4b3751b83255bdd32045a443f41))
* exit codes, argument validation, and the fixtures command ([f1b14a7](https://github.com/AraneaDev/Nemesis-MCP/commit/f1b14a75d28492b0b87f4ffb34a3e1507ce8b043))
* heritage, optional parameters, queued returns, and static spies ([172354b](https://github.com/AraneaDev/Nemesis-MCP/commit/172354b194d6f022b7a65948d6120b175367c965))
* make the Rust tier real, and follow symlinked directories ([66a9718](https://github.com/AraneaDev/Nemesis-MCP/commit/66a97182deceb767a88c9da781b4eb8f2fff84c0))
* rust test discovery, supertraits, and a symlink double-walk ([b5554a9](https://github.com/AraneaDev/Nemesis-MCP/commit/b5554a9f71948706c4d5b9d2340dcdd6ca36dae2))
