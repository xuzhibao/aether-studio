import { AnimatePresence, motion } from "motion/react";
import { AlertTriangle, Check, Sparkles, X } from "lucide-react";
import { useStudio } from "../store/studio";
import { cn } from "../lib/utils";

export function Toasts() {
  const { toasts, dismissToast } = useStudio();
  return (
    <div className="pointer-events-none fixed bottom-[38px] right-3 z-[130] flex w-[302px] flex-col gap-1.5">
      <AnimatePresence initial={false}>
        {toasts.map((toast) => (
          <motion.div
            key={toast.id}
            initial={{ opacity: 0, y: 8, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4, scale: 0.985 }}
            transition={{ duration: 0.18, ease: [0.2, 0.8, 0.2, 1] }}
            className="pointer-events-auto flex items-start gap-2.5 rounded-[9px] border border-[#E3E6EA] bg-white/95 px-2.5 py-2.5 shadow-[0_12px_34px_-12px_rgba(20,24,33,0.28),0_2px_6px_rgba(20,24,33,0.06)] backdrop-blur"
          >
            <span
              className={cn(
                "mt-[1px] flex h-[20px] w-[20px] flex-none items-center justify-center rounded-full",
                toast.tone === "success" && "bg-[#EAF6EF] text-[#2B9661]",
                toast.tone === "warn" && "bg-[#FBF3E3] text-[#B0761D]",
                (!toast.tone || toast.tone === "default") && "bg-[#EEF4FB] text-[#4C7EA8]",
              )}
            >
              {toast.tone === "success" ? <Check size={11} strokeWidth={2.4} /> : toast.tone === "warn" ? <AlertTriangle size={11} /> : <Sparkles size={10.5} />}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[10.5px] font-semibold text-[#30353B]">{toast.title}</div>
              {toast.detail && <div className="mt-[2px] text-[9px] leading-[1.45] text-[#8A9098]">{toast.detail}</div>}
            </div>
            <button className="mt-0.5 flex h-[16px] w-[16px] flex-none items-center justify-center rounded-[3px] text-[#A7ACB2] hover:bg-[#F1F3F5] hover:text-[#5E656D]" onClick={() => dismissToast(toast.id)}>
              <X size={9.5} />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
