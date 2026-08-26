import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Server state changes come over the delta socket, not polling.
      refetchOnWindowFocus: false,
    },
  },
});
