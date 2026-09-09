import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { MainLayout } from "./main-layout";
import { SetupScreen } from "./setup-screen";
import { Skeleton } from "@ui/skeleton";
import { rpcClient } from "@lib/rpc";
import { useUpdateStore } from "@lib/update-store";

export function App() {
  const queryClient = useQueryClient();

  useEffect(() => {
    rpcClient.getUpdateState().then(useUpdateStore.getState().setUpdateState);
  }, []);

  const { data, isLoading } = useQuery({
    queryKey: ["settings"],
    queryFn: () => rpcClient.getSettings(),
  });

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Skeleton className="h-8 w-48" />
      </div>
    );
  }

  if (!data?.configured) {
    return (
      <SetupScreen onComplete={() => queryClient.invalidateQueries({ queryKey: ["settings"] })} />
    );
  }

  return <MainLayout />;
}
