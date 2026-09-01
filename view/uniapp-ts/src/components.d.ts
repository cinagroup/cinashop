import type DiySuspendedNavigation from "@/components/diy/DiySuspendedNavigation.vue";

declare module "vue" {
  export interface GlobalComponents {
    DiySuspendedNavigation: typeof DiySuspendedNavigation;
  }
}

export {};
