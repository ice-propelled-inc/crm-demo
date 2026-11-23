import { useEffect, useState } from "react";
import { FORBIDDEN_EVENT, switchUser } from "./api/client";

/** Shown when the logged-in user does not have the role of this app. */
export function RoleBanner() {
  const [forbidden, setForbidden] = useState(false);
  useEffect(() => {
    const on = () => setForbidden(true);
    window.addEventListener(FORBIDDEN_EVENT, on);
    return () => window.removeEventListener(FORBIDDEN_EVENT, on);
  }, []);
  if (!forbidden) return null;
  return (
    <div className="card error" role="alert">
      You are logged in as a user without the admin role. The admin panel and the operator chat use the same login
      in one browser. Use a private window for the second user.
      <br />
      <button onClick={() => void switchUser()}>Log in as another user</button>
    </div>
  );
}

export function LogoutButton() {
  return (
    <button className="logout" onClick={() => void switchUser()}>
      Switch user
    </button>
  );
}
