# Architecture Decision Records

Short, immutable records of decisions that are expensive to reverse. One file per
decision, numbered `ADR-NNNN-<slug>.md`. Never edit an accepted ADR — supersede it
with a new one and mark the old `Superseded by ADR-NNNN`.

| ADR                                      | Title                                         | Status   |
| ---------------------------------------- | --------------------------------------------- | -------- |
| [0001](ADR-0001-ports-and-adapters.md)   | Ports and adapters, provider neutrality       | Accepted |
| [0002](ADR-0002-logging-port.md)         | Logging behind a port; Better Stack swappable | Accepted |
| [0003](ADR-0003-mongodb-as-job-truth.md) | MongoDB is the source of truth for jobs       | Accepted |

Template: Context · Decision · Consequences · Alternatives.
