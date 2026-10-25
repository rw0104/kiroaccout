import { useState, useRef, useEffect, type KeyboardEvent } from 'react'
import { ChevronDown, Check } from 'lucide-react'
import { cn } from '../../lib/utils'

interface SelectOption {
  value: string
  label: string
  description?: string
}

interface SelectProps {
  id?: string
  'aria-label'?: string
  'aria-describedby'?: string
  disabled?: boolean
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
  placeholder?: string
  className?: string
}

export function Select({ value, options, onChange, placeholder = '请选择', className, id, disabled = false, 'aria-label': ariaLabel, 'aria-describedby': ariaDescribedBy }: SelectProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const ref = useRef<HTMLDivElement>(null)

  const selectedOption = options.find(opt => opt.value === value)

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  useEffect(() => {
    const selectedIndex = options.findIndex(option => option.value === value)
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0)
  }, [options, value])

  const choose = (index: number) => {
    if (disabled) return
    const option = options[index]
    if (!option) return
    onChange(option.value)
    setIsOpen(false)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return
    if (event.key === 'Escape') { setIsOpen(false); return }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!isOpen) { setIsOpen(true); return }
      if (options.length) setActiveIndex(index => (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length)
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      if (isOpen) choose(activeIndex)
      else setIsOpen(true)
    }
  }

  return (
    <div ref={ref} className={cn('relative', className)}>
      {/* Trigger */}
      <button
        id={id}
        type="button"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        onKeyDown={handleKeyDown}
        onClick={() => { if (!disabled) setIsOpen(open => !open) }}
        className={cn(
          'flex items-center justify-between gap-2 px-3 py-2 w-full min-h-10 rounded-xl border bg-[var(--glass-bg)] backdrop-blur-md text-sm transition-[border-color,box-shadow,background-color,transform] duration-200 shadow-sm',
          'hover:border-primary/50 hover:bg-[var(--glass-bg-strong)] active:scale-[0.995]',
          isOpen && 'border-primary/50 ring-2 ring-primary/20 bg-[var(--glass-bg-strong)]',
          !isOpen && 'border-foreground/15',
          disabled && 'opacity-50 cursor-not-allowed'
        )}
      >
        <span className={cn(!selectedOption && 'text-muted-foreground')}>
          {selectedOption?.label || placeholder}
        </span>
        <ChevronDown className={cn(
          'h-4 w-4 text-muted-foreground transition-transform duration-200',
          isOpen && 'rotate-180'
        )} />
      </button>

      {/* Dropdown */}
      {isOpen && !disabled && (
        <div role="listbox" aria-label={placeholder} className="absolute top-full left-0 right-0 mt-2 max-h-72 overflow-auto py-1.5 rounded-2xl glass-card-strong z-50 shadow-xl animate-in fade-in-0 zoom-in-95 duration-150 origin-top">
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              onMouseEnter={() => setActiveIndex(options.indexOf(option))}
              onClick={() => choose(options.indexOf(option))}
              className={cn(
                'flex items-center justify-between w-full mx-1 px-3 py-2.5 text-sm text-left rounded-xl transition-[background-color,color,transform] duration-150',
                'hover:bg-primary/10 active:scale-[0.99]',
                activeIndex === options.indexOf(option) && 'bg-primary/10',
                option.value === value && 'bg-primary/5'
              )}
            >
              <div>
                <p className={cn(
                  'font-medium',
                  option.value === value && 'text-primary'
                )}>
                  {option.label}
                </p>
                {option.description && (
                  <p className="text-xs text-muted-foreground mt-0.5">{option.description}</p>
                )}
              </div>
              {option.value === value && (
                <Check className="h-4 w-4 text-primary shrink-0" />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
