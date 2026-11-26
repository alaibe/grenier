import type { PageRow, RecordRow, Top } from "@grenier/core/api";
import { FileText } from "lucide-react";
import { useCallback, useState } from "react";
import { searchRecords } from "../api.ts";
import { Empty, Skeleton } from "../ui/empty.tsx";
import { useLoad } from "../ui/load.ts";
import { Problem } from "../ui/notice.tsx";
import { Tree } from "../ui/tree.tsx";
import { pageId, pageOf } from "./knowledge-tree.ts";
import { folderPath } from "./PageEditor.tsx";

/** Pages matching the words, by meaning as well as by title, each with where it sits. */
export function Found({
  words,
  pages,
  tops,
  current,
  open,
}: {
  words: string;
  pages: PageRow[];
  tops: Top[];
  current: string | null;
  open: (id: string) => void;
}) {
  const load = useCallback(() => searchRecords<RecordRow>(words), [words]);
  const { data, error } = useLoad(load);
  const [cursor, setCursor] = useState<string | null>(current ? pageId(current) : null);
  if (error) return <Problem error={error} />;
  if (!data) return <Skeleton rows={4} />;
  const shown = new Map(pages.map((page) => [page.id, page]));
  const found = data.map((record) => shown.get(record.id)).filter((page): page is PageRow => page !== undefined);
  if (found.length === 0) {
    return (
      <Empty boot="no match" match>
        No page holds “{words}”. Try fewer words, or other ones.
      </Empty>
    );
  }
  return (
    <Tree
      label="Pages found"
      nodes={found.map((page) => ({
        id: pageId(page.id),
        name: page.title,
        icon: FileText,
        preview: folderPath(tops, page.top, page.folder),
      }))}
      selected={cursor}
      onSelect={(node) => {
        setCursor(node.id);
        const page = pageOf(node);
        if (page) open(page);
      }}
      onOpen={(node) => {
        const page = pageOf(node);
        if (page) open(page);
      }}
    />
  );
}
