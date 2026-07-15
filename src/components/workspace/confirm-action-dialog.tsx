"use client";

import * as AlertDialog from "@radix-ui/react-alert-dialog";
import {LoaderCircle} from "lucide-react";

import {Button} from "@/components/ui/button";

export interface ConfirmActionDialogProps {
  cancelLabel: string;
  confirmLabel: string;
  description: string;
  destructive?: boolean;
  onConfirm: () => void | Promise<void>;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  pending?: boolean;
  title: string;
}

export function ConfirmActionDialog({
  cancelLabel,
  confirmLabel,
  description,
  destructive = false,
  onConfirm,
  onOpenChange,
  open,
  pending = false,
  title,
}: ConfirmActionDialogProps) {
  return (
    <AlertDialog.Root onOpenChange={onOpenChange} open={open}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/45 backdrop-blur-[2px]" />
        <AlertDialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(92vw,30rem)] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-surface-raised p-5 text-foreground shadow-2xl">
          <AlertDialog.Title className="text-lg font-semibold">{title}</AlertDialog.Title>
          <AlertDialog.Description className="mt-2 text-sm leading-7 text-muted-foreground">
            {description}
          </AlertDialog.Description>
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <Button disabled={pending} variant="ghost">
                {cancelLabel}
              </Button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <Button
                disabled={pending}
                onClick={(clickEvent) => {
                  clickEvent.preventDefault();
                  void onConfirm();
                }}
                variant={destructive ? "destructive" : "primary"}
              >
                {pending ? (
                  <LoaderCircle
                    aria-hidden="true"
                    className="size-4 animate-spin motion-reduce:animate-none"
                  />
                ) : null}
                {confirmLabel}
              </Button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
