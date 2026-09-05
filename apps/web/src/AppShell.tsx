import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { LayoutDashboard, PanelLeft, ReceiptText } from "lucide-react";

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "./components/ui/sidebar";

const navItems = [
  { label: "Dashboard", to: "/", icon: LayoutDashboard, exact: true },
  { label: "Tax", to: "/tax", icon: ReceiptText, exact: false },
] as const;

function AppNavigation() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const { isMobile, setOpenMobile } = useSidebar();

  return (
    <SidebarMenu>
      {navItems.map((item) => {
        const Icon = item.icon;
        const isActive = item.exact
          ? pathname === item.to
          : pathname === item.to || pathname.startsWith(`${item.to}/`);

        return (
          <SidebarMenuItem key={item.to}>
            <SidebarMenuButton asChild isActive={isActive} tooltip={item.label}>
              <Link
                to={item.to}
                activeOptions={item.exact ? { exact: true } : undefined}
                preload="intent"
                className="flex items-center gap-2"
                onClick={() => {
                  if (isMobile) setOpenMobile(false);
                }}
              >
                <Icon />
                <span>{item.label}</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        );
      })}
    </SidebarMenu>
  );
}

function SidebarBrand() {
  const { state } = useSidebar();

  if (state === "collapsed") return null;

  return (
    <div className="min-w-0 flex-1">
      <p className="text-[0.65rem] font-semibold tracking-[0.22em] text-neutral-500 uppercase">
        HyperEVM ProjectX
      </p>
      <p className="mt-1 truncate text-sm font-semibold text-neutral-900">Portfolio workspace</p>
    </div>
  );
}

function SidebarHint() {
  const { state } = useSidebar();

  return (
    <div className="flex items-center gap-2">
      <PanelLeft className="h-4 w-4 shrink-0" />
      {state === "expanded" ? <span>Collapse with the trigger or Ctrl/Cmd+B</span> : null}
    </div>
  );
}

export function AppShell() {
  return (
    <SidebarProvider defaultOpen>
      <Sidebar collapsible="icon" variant="inset">
        <SidebarHeader className="border-b border-neutral-200 px-3 py-3">
          <div className="flex items-center justify-between gap-2">
            <SidebarBrand />
            <SidebarTrigger className="shrink-0" aria-label="Toggle sidebar" />
          </div>
        </SidebarHeader>

        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Navigation</SidebarGroupLabel>
            <SidebarGroupContent>
              <AppNavigation />
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>

        <SidebarFooter className="border-t border-neutral-200 px-3 py-3 text-xs text-neutral-500">
          <SidebarHint />
        </SidebarFooter>
      </Sidebar>

      <SidebarInset>
        <div className="flex min-h-svh min-w-0 flex-col bg-white text-neutral-950">
          <div className="border-b border-neutral-200 bg-white/95 px-4 py-3 backdrop-blur sm:px-6 lg:px-8">
            <div className="flex items-center gap-3">
              <SidebarTrigger className="md:hidden" aria-label="Open sidebar" />
              <div className="min-w-0">
                <p className="text-[0.65rem] font-semibold tracking-[0.22em] text-neutral-500 uppercase">
                  LP tracker
                </p>
                <p className="truncate text-sm font-medium text-neutral-700">
                  Dashboard and tax workflows
                </p>
              </div>
            </div>
          </div>

          <main className="min-w-0 flex-1">
            <div className="mx-auto w-full max-w-[1440px] min-w-0 px-4 py-4 sm:px-6 lg:px-8">
              <Outlet />
            </div>
          </main>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
