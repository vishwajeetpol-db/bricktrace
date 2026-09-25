import { useEffect, useState } from "react";
import { Bell, HelpCircle, Sun, Moon } from "lucide-react";
import { useThemeStore } from "../../store/themeStore";
import { goNotifications } from "../../hooks/useRouter";

/** Shared top-right action cluster: notifications, help, theme toggle.
 *  Rendered on every screen's top bar so the controls stay in one place. */
export default function HeaderActions() {
  const theme = useThemeStore((s) => s.theme);
  const toggleTheme = useThemeStore((s) => s.toggleTheme);
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    fetch("/api/notifications/unread-count")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (typeof d?.count === "number") setUnread(d.count); })
      .catch(() => { /* count is best-effort */ });
  }, []);

  return (
    <div className="flex items-center gap-3.5 shrink-0">
      <button
        onClick={goNotifications}
        title="Notifications"
        aria-label="Notifications"
        className="relative text-slate-400 hover:text-slate-200 transition-colors"
      >
        <Bell size={18} />
        {unread > 0 && (
          <span className="absolute -top-1.5 -right-1.5 min-w-[15px] h-[15px] px-1 rounded-full bg-accent text-white text-[9px] font-bold flex items-center justify-center leading-none">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>
      <button title="Help" aria-label="Help" className="text-slate-400 hover:text-slate-200 transition-colors">
        <HelpCircle size={18} />
      </button>
      <button
        onClick={toggleTheme}
        title={theme === "dark" ? "Light mode" : "Dark mode"}
        aria-label="Toggle theme"
        className="text-slate-400 hover:text-slate-200 transition-colors"
      >
        {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
      </button>
    </div>
  );
}
