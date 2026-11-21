'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { Check, Copy, Download, KeyRound, Loader2, Printer, ShieldCheck, ShieldOff } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api, errorMessage } from '@/lib/api';

/** Ô nhập mã 6 số từ ứng dụng xác thực */
export function OtpInput({ value, onChange, id = 'otp', autoFocus, disabled }: { value: string; onChange: (v: string) => void; id?: string; autoFocus?: boolean; disabled?: boolean }) {
  return (
    <Input
      id={id}
      inputMode="numeric"
      autoComplete="one-time-code"
      placeholder="123 456"
      maxLength={6}
      value={value}
      autoFocus={autoFocus}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value.replace(/[^\d]/g, '').slice(0, 6))}
      className="max-w-[12rem] font-mono text-lg tracking-[0.35em]"
    />
  );
}

/**
 * Bộ mã dự phòng — chỉ hiển thị 1 lần ngay sau khi bật / tạo lại. Cho copy, tải về, in.
 */
export function RecoveryCodes({ codes, email }: { codes: string[]; email?: string }) {
  const [copied, setCopied] = useState(false);
  const text = `Mã dự phòng xác thực 2 bước${email ? ` — ${email}` : ''}\nMỗi mã chỉ dùng được một lần. Giữ ở nơi an toàn.\n\n${codes.join('\n')}\n`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(codes.join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Không copy được, hãy chọn và sao chép thủ công');
    }
  };
  const download = () => {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'cmsnt-recovery-codes.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const print = () => {
    const w = window.open('', '_blank', 'width=480,height=640');
    if (!w) return;
    w.document.write(`<pre style="font: 14px/1.8 ui-monospace, monospace; padding: 24px">${text.replace(/</g, '&lt;')}</pre>`);
    w.document.close();
    w.focus();
    w.print();
  };

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
        Lưu các mã này ở nơi an toàn (trình quản lý mật khẩu, in ra giấy). Chúng chỉ hiển thị <b>một lần</b>. Dùng khi mất điện thoại — mỗi mã dùng được một lần.
      </div>
      <ol className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-lg border bg-muted/40 p-4 font-mono text-sm sm:grid-cols-2">
        {codes.map((c, i) => (
          <li key={c} className="flex items-center gap-2">
            <span className="w-5 text-right text-xs text-muted-foreground">{i + 1}.</span>
            <span className="select-all tracking-wide">{c}</span>
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" onClick={copy}>
          {copied ? <Check /> : <Copy />} {copied ? 'Đã copy' : 'Copy'}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={download}>
          <Download /> Tải về (.txt)
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={print}>
          <Printer /> In
        </Button>
      </div>
    </div>
  );
}

/**
 * Dialog bật xác thực 2 bước: bước 1 quét QR (hoặc nhập secret), bước 2 nhập mã xác nhận,
 * bước 3 hiển thị mã dự phòng 1 lần. `onEnabled` gọi sau khi bật xong (để tải lại hồ sơ).
 */
export function Enable2faDialog({ open, onOpenChange, email, onEnabled }: { open: boolean; onOpenChange: (o: boolean) => void; email: string; onEnabled?: () => void }) {
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [showSecret, setShowSecret] = useState(false);

  const start = useMutation({
    mutationFn: () => api.post<{ secret: string; otpauthUrl: string }>('/auth/2fa/setup'),
    onSuccess: async (data) => {
      setSetup(data);
      try {
        setQr(await QRCode.toDataURL(data.otpauthUrl, { width: 220, margin: 1, errorCorrectionLevel: 'M' }));
      } catch {
        setQr(null);
      }
    },
    onError: (e) => {
      toast.error(errorMessage(e));
      onOpenChange(false);
    },
  });
  const enable = useMutation({
    mutationFn: () => api.post<{ recoveryCodes: string[] }>('/auth/2fa/enable', { code }),
    onSuccess: (data) => {
      setCodes(data.recoveryCodes);
      toast.success('Đã bật xác thực 2 bước');
      onEnabled?.();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  // mỗi lần mở dialog tạo secret mới
  useEffect(() => {
    if (!open) return;
    setSetup(null);
    setQr(null);
    setCode('');
    setCodes(null);
    setShowSecret(false);
    start.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (code.length !== 6) return toast.error('Nhập đủ 6 số');
    enable.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !enable.isPending && onOpenChange(o)}>
      <DialogContent className="sm:max-w-lg">
        {codes ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <ShieldCheck className="size-5 text-emerald-600 dark:text-emerald-400" /> Đã bật xác thực 2 bước
              </DialogTitle>
              <DialogDescription>Từ lần đăng nhập sau, bạn sẽ cần nhập mã từ ứng dụng xác thực.</DialogDescription>
            </DialogHeader>
            <RecoveryCodes codes={codes} email={email} />
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>Tôi đã lưu mã dự phòng</Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={submit} className="space-y-5">
            <DialogHeader>
              <DialogTitle>Bật xác thực 2 bước</DialogTitle>
              <DialogDescription>Dùng ứng dụng xác thực như Google Authenticator, Microsoft Authenticator, Authy hoặc 1Password.</DialogDescription>
            </DialogHeader>
            <ol className="space-y-4 text-sm">
              <li className="flex gap-3">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">1</span>
                <div className="min-w-0 flex-1 space-y-3">
                  <p>Mở ứng dụng xác thực và quét mã QR:</p>
                  <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start">
                    <div className="flex size-[232px] shrink-0 items-center justify-center rounded-lg border bg-white p-1">
                      {start.isPending || !setup ? <Loader2 className="size-6 animate-spin text-muted-foreground" /> : qr ? (
                        // QR là data URL tạo tại trình duyệt — next/image không tối ưu được data URL nên dùng <img> thường
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={qr} alt="Mã QR thiết lập 2FA" width={220} height={220} />
                      ) : <span className="px-4 text-center text-xs text-muted-foreground">Không vẽ được QR — nhập secret thủ công</span>}
                    </div>
                    <div className="min-w-0 flex-1 space-y-2 text-xs text-muted-foreground">
                      <p>Không quét được? Nhập thủ công vào ứng dụng:</p>
                      {setup && (
                        <>
                          <button type="button" className="text-primary hover:underline" onClick={() => setShowSecret((v) => !v)}>
                            {showSecret ? 'Ẩn mã bí mật' : 'Hiện mã bí mật'}
                          </button>
                          {showSecret && (
                            <div className="flex items-center gap-1">
                              <code className="break-all rounded bg-muted px-2 py-1 font-mono text-[11px] tracking-wider text-foreground">{setup.secret.match(/.{1,4}/g)?.join(' ')}</code>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-xs"
                                aria-label="Copy mã bí mật"
                                onClick={() => {
                                  void navigator.clipboard.writeText(setup.secret);
                                  toast.success('Đã copy');
                                }}
                              >
                                <Copy />
                              </Button>
                            </div>
                          )}
                          <p>
                            Loại: theo thời gian (TOTP) · 6 số · 30 giây · tài khoản <span className="font-medium text-foreground">{email}</span>
                          </p>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              </li>
              <li className="flex gap-3">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">2</span>
                <div className="flex-1 space-y-2">
                  <Label htmlFor="enable-otp">Nhập mã 6 số đang hiển thị trong ứng dụng</Label>
                  <OtpInput id="enable-otp" value={code} onChange={setCode} disabled={!setup || enable.isPending} />
                </div>
              </li>
            </ol>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={enable.isPending}>
                Huỷ
              </Button>
              <Button type="submit" disabled={!setup || code.length !== 6 || enable.isPending}>
                {enable.isPending ? <Loader2 className="animate-spin" /> : <ShieldCheck />} Xác nhận & bật
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Dialog yêu cầu mã xác thực (hoặc mật khẩu) rồi gọi API: dùng cho Tắt 2FA và Tạo lại mã dự phòng */
export function Confirm2faDialog({
  open,
  onOpenChange,
  title,
  description,
  allowPassword,
  destructive,
  confirmText,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description?: string;
  /** cho phép xác nhận bằng mật khẩu thay cho mã (khi mất điện thoại) */
  allowPassword?: boolean;
  destructive?: boolean;
  confirmText: string;
  onConfirm: (input: { code?: string; password?: string }) => Promise<void>;
}) {
  const [usePassword, setUsePassword] = useState(false);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setUsePassword(false);
      setCode('');
      setPassword('');
    }
  }, [open]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await onConfirm(usePassword ? { password } : { code: code.trim() });
      onOpenChange(false);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="space-y-5">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">{destructive ? <ShieldOff className="size-5 text-destructive" /> : <KeyRound className="size-5" />} {title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
          {usePassword ? (
            <div className="space-y-2">
              <Label htmlFor="confirm-pw">Mật khẩu hiện tại</Label>
              <Input id="confirm-pw" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus disabled={busy} />
            </div>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="confirm-otp">Mã từ ứng dụng xác thực (hoặc mã dự phòng)</Label>
              <Input id="confirm-otp" autoComplete="one-time-code" placeholder="123456 hoặc xxxxx-xxxxx" value={code} onChange={(e) => setCode(e.target.value)} autoFocus disabled={busy} className="max-w-[16rem] font-mono tracking-wider" />
            </div>
          )}
          {allowPassword && (
            <button type="button" className="text-xs text-primary hover:underline" onClick={() => setUsePassword((v) => !v)} disabled={busy}>
              {usePassword ? 'Dùng mã xác thực' : 'Mất điện thoại? Xác nhận bằng mật khẩu'}
            </button>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
              Huỷ
            </Button>
            <Button type="submit" variant={destructive ? 'destructive' : 'default'} disabled={busy || (usePassword ? !password : !code.trim())}>
              {busy && <Loader2 className="animate-spin" />} {confirmText}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
