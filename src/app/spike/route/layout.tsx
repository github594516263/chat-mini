/** 【临时·路由改造 A/B 实测用】把状态挂在 layout 层：param 变化时 layout 不重挂。 */

import type { ReactNode } from "react";

import { SpikeStateProvider } from "./spike-state";

export default function SpikeRouteLayout({ children }: { children: ReactNode }) {
  return <SpikeStateProvider>{children}</SpikeStateProvider>;
}
