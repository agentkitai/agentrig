# Offline pinned is-number source fixture

`is-number-pinned.bundle` is a standard Git bundle of the public
[jonschlinkert/is-number](https://github.com/jonschlinkert/is-number) repository,
prepared on 2026-09-06 for network-free tests of the existing E1 X-task preparation
path. It is not a reconstructed subset or a substitute fixture revision.

- Commit: `98e8ff1da1a89f93d1397a24d7413ed15421c139` (the existing `IS_NUMBER_REVISION`).
- Tree: `37450e1347ebbad642393376ee3ef67f576d1109`.
- Ref: `refs/heads/fixture`; 62 reachable commits, no unrelated branch refs.
- Size: 60,073 bytes; tests enforce a 128 KiB upper bound.
- SHA-256: `a6c67990dd64419575a5192f267e93402d2457404f1c24ce422e030dd0dede11`.

Preparation fetched this exact public revision, obtained its ancestry, created
the single `fixture` ref and ran `git bundle create ... refs/heads/fixture`.
The complete reachable ancestry makes this a standalone bundle with no shallow
prerequisites. Tests clone it locally and verify the commit, tree, ref and digest;
neither tests nor product execution fetch it from the network. E1 still checks its
original revision and uses `git archive` when creating the agent workspace, so
the model does not receive source history or an unseeded checkout.

Audit with `git bundle list-heads eval/fixtures/is-number-pinned.bundle`, then
`git clone --branch fixture eval/fixtures/is-number-pinned.bundle NEW_DIRECTORY`
and inspect `git rev-parse HEAD`, `git rev-parse HEAD^{tree}` and `git log` there.
The cloned source's `LICENSE` contains the following upstream license, retained
here as well for distribution of the bundle:

```text
The MIT License (MIT)

Copyright (c) 2014-present, Jon Schlinkert.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```
