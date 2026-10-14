import React, {
  forwardRef,
  useImperativeHandle,
  useRef,
  useState,
  useEffect,
} from "react";

interface VerifyCodeInputProps {
  length?: number;
  loading?: boolean;
  onComplete: (code: string) => void;
}

export interface VerifyCodeInputHandle {
  reset: () => void;
}

const VerifyCodeInput = forwardRef<VerifyCodeInputHandle, VerifyCodeInputProps>(
  ({ length = 5, loading, onComplete }, ref) => {
    const [digits, setDigits] = useState<string[]>(Array(length).fill(""));
    const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

    useImperativeHandle(ref, () => ({
      reset: () => {
        setDigits(Array(length).fill(""));
        inputRefs.current[0]?.focus();
      },
    }));

    useEffect(() => {
      if (digits.every((d) => d.length === 1)) {
        onComplete(digits.join(""));
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [digits]);

    const setDigit = (index: number, value: string) => {
      const next = [...digits];
      next[index] = value;
      setDigits(next);
    };

    const onChange = (index: number, value: string) => {
      const digit = value.replace(/[^0-9]/g, "").slice(-1);
      setDigit(index, digit);
      if (digit && index < length - 1) {
        inputRefs.current[index + 1]?.focus();
      }
    };

    const onKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Backspace" && !digits[index] && index > 0) {
        inputRefs.current[index - 1]?.focus();
      } else if (e.key === "ArrowLeft" && index > 0) {
        inputRefs.current[index - 1]?.focus();
      } else if (e.key === "ArrowRight" && index < length - 1) {
        inputRefs.current[index + 1]?.focus();
      }
    };

    return (
      <div className="input-digits">
        {digits.map((digit, index) => (
          <input
            key={index}
            ref={(el) => {
              inputRefs.current[index] = el;
            }}
            type="tel"
            maxLength={1}
            autoFocus={index === 0}
            disabled={loading}
            value={digit}
            onChange={(e) => onChange(index, e.target.value)}
            onKeyDown={(e) => onKeyDown(index, e)}
          />
        ))}
      </div>
    );
  }
);

export default VerifyCodeInput;
