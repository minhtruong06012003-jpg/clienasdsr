"use client"

/**
 * Dropdown chọn một giá trị dựng trên Headless UI Listbox.
 * Thay cho Radix Select ở các ô chọn danh sách dài (mạng xã hội, danh mục, dịch vụ):
 * - cuộn bằng thanh cuộn gốc của trình duyệt (không có nút mũi tên tự cuộn, không khoá cuộn trang) nên không bị giật;
 * - luôn hiện thanh cuộn mảnh để người dùng biết danh sách còn dài;
 * - danh sách bám dưới ô chọn, rộng bằng ô chọn (anchor của Headless UI).
 */

import * as React from "react"
import { cn } from "cn"
import { Listbox, ListboxButton, ListboxOption, ListboxOptions } from "@headlessui/react"
import { CheckIcon, ChevronDownIcon } from "lucide-react"

export type ListboxSelectOption = {
  value: string
  /** nội dung hiển thị của dòng (có thể kèm icon) */
  label: React.ReactNode
}

type Props = {
  value: string | undefined
  onValueChange: (value: string) => void
  options: ListboxSelectOption[]
  placeholder?: React.ReactNode
  disabled?: boolean
  /** class cho ô bấm mở dropdown */
  triggerClassName?: string
  /** class cho khung danh sách */
  contentClassName?: string
  /** class cho từng dòng; dòng đang chọn có data-selected */
  itemClassName?: string
}

function ListboxSelect({
  value,
  onValueChange,
  options,
  placeholder,
  disabled,
  triggerClassName,
  contentClassName,
  itemClassName,
}: Props) {
  // lấy nhãn của dòng đang chọn để hiện trên ô bấm
  const selected = options.find((o) => o.value === value)

  return (
    <Listbox value={value ?? ""} onChange={onValueChange} disabled={disabled}>
      <ListboxButton
        data-slot="listbox-trigger"
        className={cn(
          "flex h-10 w-full min-w-0 items-center justify-between gap-1.5 rounded-xl border border-input bg-muted py-2 pr-3 pl-3.5 text-left text-sm whitespace-nowrap transition-colors outline-none select-none hover:border-border-strong focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 data-disabled:cursor-not-allowed data-disabled:opacity-50 dark:border-white/[0.07] dark:bg-black/35 dark:hover:border-white/15 dark:hover:bg-black/45 [&_svg]:shrink-0",
          triggerClassName
        )}
      >
        <span
          data-slot="listbox-value"
          className={cn("flex min-w-0 items-center gap-2 overflow-hidden", !selected && "text-muted-foreground")}
        >
          {selected ? selected.label : placeholder}
        </span>
        <ChevronDownIcon className="pointer-events-none size-4 text-muted-foreground" />
      </ListboxButton>

      <ListboxOptions
        // bám mép dưới ô chọn, cách 4px; Headless UI tự lật lên trên nếu thiếu chỗ
        anchor={{ to: "bottom start", gap: 4 }}
        // modal={false}: không khoá cuộn trang khi mở (nguyên nhân giật của Radix)
        modal={false}
        data-slot="listbox-content"
        className={cn(
          "listbox-scroll z-50 max-h-96 w-(--button-width) max-w-[calc(100vw-1.5rem)] overflow-y-auto overscroll-contain rounded-2xl bg-popover p-1.5 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none [--anchor-max-height:24rem]",
          "transition duration-100 ease-out data-closed:scale-95 data-closed:opacity-0",
          contentClassName
        )}
        transition
      >
        {options.map((o) => (
          <ListboxOption
            key={o.value}
            value={o.value}
            className={cn(
              "group relative flex min-h-11 cursor-default items-center gap-2.5 rounded-xl py-2.5 pr-10 pl-3 text-[15px] select-none data-disabled:opacity-50 data-focus:bg-accent data-focus:text-accent-foreground [&_svg]:shrink-0",
              itemClassName
            )}
          >
            {o.label}
            {/* dấu tích ở dòng đang chọn */}
            <CheckIcon className="pointer-events-none absolute right-3 size-5 invisible group-data-selected:visible" />
          </ListboxOption>
        ))}
      </ListboxOptions>
    </Listbox>
  )
}

export { ListboxSelect }
