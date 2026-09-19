# ADR-002: Static analysis: SonarQube quality gate, CodeQL as a second layer

- Status: Accepted
- Scope: Implementation decision under the [technology baseline](../architecture/engineering-standards.md#technology-baseline) ("SonarQube-compatible static analysis"). Does not change the engineering standards. Tracked in [issue #2](https://github.com/veyselkaraca/platform-engineering-lab/issues/2).

## Context

The service pipelines ran CodeQL as their only static analysis step. That step uploads findings to GitHub code scanning but never fails a build, and no severity threshold was ever agreed. The standards list static analysis as a pipeline stage and name SonarQube-compatible analysis in the baseline. A gate that cannot fail is not a control.

## Decision

- **SonarQube (Community Build) is the quality gate.** Each service pipeline starts a throwaway SonarQube server as a service container, runs the scanner with `sonar.qualitygate.wait=true`, and fails the build when the gate fails. A persistent instance in the local compose stack (profile `quality`) shows the same analysis on a dashboard.
- **The gate is SonarQube's built-in "Sonar way"** (conditions on new code; on a throwaway server the first analysis treats all code as new, so every run judges the whole code base):
  - no new issues, and Reliability, Security and Maintainability ratings are all A;
  - all Security Hotspots are reviewed (100 %);
  - coverage on new code is at least 80 %;
  - duplicated lines density on new code is at most 3 %.
- **CodeQL stays as a security-focused second layer that does not gate.** It reports data-flow findings to the repository Security tab. There is exactly one blocking gate, so there is one place to look when a build fails.
- **Gate and scanner configuration are files in `security/sonar/`**; CodeQL configuration is in `security/sast/`. Nothing is set by hand in a UI.
- Coverage comes from Jest (`lcov`) so the coverage condition is real. At the time of this decision the lowest service is at 81 % statements.

## Consequences

- The pipeline gains one heavier job (SonarQube needs roughly 2 GB of memory and a start-up wait) per service pipeline.
- Because the CI server is throwaway there is no history, no trend and no branch or pull-request analysis (Community Build has none). The persistent local instance is the demonstration surface; CI is the enforcement surface.
- A Security Hotspot cannot be marked reviewed on a throwaway server, so any hotspot the scanner raises fails the gate until the code is changed. This is deliberately strict; if it turns into noise the fix is a documented change to the gate, not disabling it.
- The gate conditions are recorded here and in [static analysis](../security/static-analysis.md); changing them means updating both.

## Alternatives considered

- **CodeQL only:** zero infrastructure, but it has no quality gate, no coverage or duplication signal, and does not demonstrate operating a static analysis platform; rejected.
- **SonarCloud:** no server to run and PR decoration, but the platform's point is to operate the tooling itself and the standards ask for SonarQube-compatible analysis that also runs locally; rejected.
- **Two blocking gates (Sonar and CodeQL):** doubles the places a build can fail and the upkeep for little added assurance; rejected.
- **A persistent SonarQube server for CI:** would give history and trends but needs a hosted server reachable from GitHub runners and a stored token; out of proportion for a lab, and can be added later without changing the gate.
- **Custom quality gate with a coverage threshold from measured baselines:** tighter, but the built-in gate is the conventional, explainable choice; can be revisited once there is history to base numbers on.
