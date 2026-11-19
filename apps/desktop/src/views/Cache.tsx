import { useCallback, useState } from "react";
import type { ViewProps } from "../App.tsx";
import { api, type CachedAnswer, type CacheRepo } from "../api.ts";
import {
  ConfirmButton,
  count,
  Empty,
  Loading,
  moment,
  Notice,
  Page,
  Select,
  times,
  useAction,
  useLoad,
} from "../ui.tsx";

const loadRepos = () => api<{ repos: CacheRepo[] }>("/cache");
const BADGE = "shrink-0 rounded-[5px] border px-1.75 text-xs leading-5";

export function Cache(_: ViewProps) {
  const repos = useLoad(loadRepos);
  const [chosen, setChosen] = useState("");
  const list = repos.data?.repos ?? [];
  const repo = list.find((entry) => entry.id === chosen) ?? list[0];

  return (
    <Page
      title="Exploration cache"
      intro="What agents worked out about your code and recorded. An answer is reused until one of the files it came from changes; forget one that is wrong."
      action={
        list.length > 1 && (
          <label>
            <span className="sr-only">Repository</span>
            <Select className="min-w-40" value={repo?.id ?? ""} onChange={(event) => setChosen(event.target.value)}>
              {list.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name} · {count(entry.answers)} answers
                </option>
              ))}
            </Select>
          </label>
        )
      }
    >
      <Notice message={repos.error} />
      {!repos.data && !repos.error && <Loading what="the cache" />}
      {repos.data && list.length === 0 && (
        <Empty>
          <p>Nothing recorded yet. Give your agent Grenier's tools, and what it works out shows here:</p>
          <code>grenier mcp install claude-code</code>
        </Empty>
      )}
      {repo && <Answers key={repo.id} repo={repo} changed={repos.reload} />}
    </Page>
  );
}

function Answers({ repo, changed }: { repo: CacheRepo; changed: () => void }) {
  const load = useCallback(() => api<{ answers: CachedAnswer[] }>(`/cache/${encodeURIComponent(repo.id)}`), [repo.id]);
  const { data, error, reload } = useLoad(load);
  const action = useAction(() => {
    reload();
    changed();
  });

  const forget = (answer: CachedAnswer) => {
    void action.run(`forget:${answer.id}`, async () => {
      await api(`/cache/answers/${encodeURIComponent(answer.id)}`, { method: "DELETE" });
      return { text: "Forgot the answer." };
    });
  };

  return (
    <>
      <Notice message={error ?? action.message} />
      <p className="mb-4 text-muted">
        {count(repo.answers)} {repo.answers === 1 ? "answer" : "answers"}, reused {times(repo.hits, "time")}, and{" "}
        {count(repo.summaries)} file summaries; {repo.shared ? "shared with your team" : "kept on this machine"}.
      </p>
      {!data && !error && <Loading what="answers" />}
      {data && data.answers.length === 0 && <Empty>No answers in this repository, only file summaries.</Empty>}
      {data?.answers.map((answer) => (
        <article className="mb-4 rounded-xl border border-line bg-panel px-5 py-4" key={answer.id}>
          <header className="flex items-start justify-between gap-3">
            <h2 className="font-semibold">{answer.question}</h2>
            <State changed={answer.changed} />
          </header>
          <p className="mt-1 text-md text-muted">
            {answer.author === "local" ? "Recorded here" : `From ${answer.author}`}, {moment(answer.createdAt)} · reused{" "}
            {times(answer.hits, "time")}
          </p>
          <details className="mt-2">
            <summary className="cursor-pointer text-md text-muted">Answer and files</summary>
            <p className="mt-2 whitespace-pre-wrap">{answer.answer}</p>
            <p className="mt-2 flex flex-wrap gap-1.5 text-sm">
              {answer.files.map((file) => (
                <code key={file}>{file}</code>
              ))}
            </p>
          </details>
          {answer.shareError && (
            <p className="mt-2 text-sm text-problem">
              Not shared with your team, which refused it: {answer.shareError}
            </p>
          )}
          <div className="mt-3">
            <ConfirmButton
              label={action.busy === `forget:${answer.id}` ? "Forgetting…" : "Forget"}
              question={`Forget this answer?${answer.shared ? " It is forgotten on your teammates' machines too." : ""}`}
              disabled={action.busy !== null}
              onConfirm={() => forget(answer)}
            />
          </div>
        </article>
      ))}
    </>
  );
}

function State({ changed }: { changed: string[] | null }) {
  if (changed === null) {
    return (
      <span className={`${BADGE} border-line-strong text-muted`} title="The repository is not on this machine">
        unknown
      </span>
    );
  }
  if (changed.length === 0) return <span className={`${BADGE} border-edit text-edit`}>current</span>;
  return (
    <span className={`${BADGE} border-accent text-accent`} title={`Changed since: ${changed.join(", ")}`}>
      stale
    </span>
  );
}
