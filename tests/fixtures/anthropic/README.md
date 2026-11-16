# Anthropic Messages API fixtures

Request and response bodies in the shape the Messages API documents, written by hand: no key was used to record
them, and they hold no personal content. Byte-for-byte tests replay the `.sse` and `.json` files exactly, so keep
their line endings (LF) and the blank line that ends each event.

- `stream-tool-use.sse`: a streamed answer with text, a ping and one `tool_use`, with prompt-cache reads and writes.
- `message.json`: the same kind of answer, not streamed.
- `overloaded.json`: the error body of a `529`.
