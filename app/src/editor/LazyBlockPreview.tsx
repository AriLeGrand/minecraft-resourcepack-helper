// The 3D view loaded on demand: three.js is a large library, so it is split
// out of the main bundle and fetched the first time a 3D view is shown.
import { lazy, Suspense } from "react";
import type { BlockPreviewProps } from "./BlockPreview";

const Impl = lazy(() => import("./BlockPreview").then((m) => ({ default: m.BlockPreview })));

export function BlockPreview(props: BlockPreviewProps) {
  return (
    <Suspense fallback={<div style={{ height: props.height }} aria-busy="true" />}>
      <Impl {...props} />
    </Suspense>
  );
}
