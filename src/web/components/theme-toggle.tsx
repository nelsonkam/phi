import { useState } from "react";
import { Moon, Sun } from "lucide-react";
import { Button } from "@/web/components/ui/button";
import { getTheme, toggleTheme, type Theme } from "@/web/lib/theme";

export function ThemeToggle() {
  const [theme, setThemeState] = useState<Theme>(getTheme);

  function onToggle() {
    setThemeState(toggleTheme());
  }

  const next = theme === "dark" ? "light" : "dark";

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      onClick={onToggle}
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
    >
      {theme === "dark" ? <Sun /> : <Moon />}
    </Button>
  );
}
