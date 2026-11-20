// The scene's 3D view loaded on demand (three.js stays out of the main bundle).
import { lazy, Suspense } from "react";
import type { SceneViewProps } from "./SceneView";

const Impl = lazy(() => import("./SceneView").then((m) => ({ default: m.SceneView })));

export function SceneView(props: SceneViewProps) {
  return (
    <Suspense fallback={<div className="sc-view" aria-busy="true" />}>
      <Impl {...props} />
    </Suspense>
  );
}
