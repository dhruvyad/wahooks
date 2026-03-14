"use client";

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
} from "react";

interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  destructive?: boolean;
}

interface ConfirmContextValue {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
}

const ConfirmContext = createContext<ConfirmContextValue | null>(null);

export function useConfirm() {
  const ctx = useContext(ConfirmContext);
  if (!ctx)
    throw new Error("useConfirm must be used within ConfirmModalProvider");
  return ctx;
}

export function ConfirmModalProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<ConfirmOptions | null>(null);
  const [visible, setVisible] = useState(false);
  const resolveRef = useRef<((value: boolean) => void) | null>(null);

  const confirm = useCallback((options: ConfirmOptions): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve;
      setPending(options);
    });
  }, []);

  useEffect(() => {
    if (pending) {
      // Trigger fade-in on next frame
      requestAnimationFrame(() => setVisible(true));
    }
  }, [pending]);

  function handleResolve(value: boolean) {
    setVisible(false);
    setTimeout(() => {
      resolveRef.current?.(value);
      resolveRef.current = null;
      setPending(null);
    }, 150);
  }

  return (
    <ConfirmContext.Provider value={{ confirm }}>
      {children}
      {pending && (
        <div
          className={`fixed inset-0 z-50 flex items-center justify-center transition-all duration-150 ${
            visible ? "opacity-100" : "opacity-0"
          }`}
        >
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => handleResolve(false)}
          />
          {/* Modal */}
          <div
            className={`relative z-10 w-full max-w-md rounded-xl border border-border-secondary bg-bg-secondary p-6 shadow-2xl transition-all duration-150 ${
              visible ? "scale-100 opacity-100" : "scale-95 opacity-0"
            }`}
          >
            <h2 className="text-lg font-semibold text-text-primary">
              {pending.title}
            </h2>
            <p className="mt-2 text-sm text-text-secondary">
              {pending.message}
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <button
                onClick={() => handleResolve(false)}
                className="rounded-lg border border-border-secondary px-4 py-2 text-sm font-medium text-text-secondary transition-colors duration-150 hover:bg-bg-hover"
              >
                Cancel
              </button>
              <button
                onClick={() => handleResolve(true)}
                className={`rounded-lg px-4 py-2 text-sm font-semibold transition-colors duration-150 ${
                  pending.destructive !== false
                    ? "bg-red-600 text-white hover:bg-red-700"
                    : "bg-wa-green text-text-inverse hover:bg-wa-green-dark"
                }`}
              >
                {pending.confirmLabel || "Confirm"}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}
