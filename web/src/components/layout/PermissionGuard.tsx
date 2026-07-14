import React, { useEffect, useState } from "react";
import { accessControlProvider } from "../../app/providers/access-control-provider";

interface PermissionGuardProps {
  resource: string;
  action: string;
  fallback?: React.ReactNode;
  children: React.ReactNode;
}

export const PermissionGuard: React.FC<PermissionGuardProps> = ({
  resource,
  action,
  fallback = null,
  children,
}) => {
  const [allowed, setAllowed] = useState<boolean | null>(null);

  useEffect(() => {
    let active = true;
    accessControlProvider.can({ resource, action }).then((res) => {
      if (active) {
        setAllowed(res.can);
      }
    });
    return () => {
      active = false;
    };
  }, [resource, action]);

  if (allowed === null) return null;
  return allowed ? <>{children}</> : <>{fallback}</>;
};
