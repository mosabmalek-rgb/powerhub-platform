import { useAuth } from "@/_core/hooks/useAuth";
import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trpc } from "@/lib/trpc";
import { KeyRound, Loader2, ShieldCheck, UserRound } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";

const inputClass = "h-11 border-white/10 bg-white/[.025] text-white placeholder:text-slate-600";

export default function ProfileSecurityPage() {
  const [, setLocation] = useLocation();
  const { user, loading, isAuthenticated } = useAuth();
  const utils = trpc.useUtils();
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  useEffect(() => setName(user?.name ?? ""), [user?.name]);
  const updateProfile = trpc.auth.updateProfile.useMutation({ onSuccess: async () => { await utils.auth.me.invalidate(); toast.success("تم حفظ بياناتك الشخصية."); }, onError: (error) => toast.error(error.message) });
  const updatePassword = trpc.auth.updatePassword.useMutation({ onSuccess: async () => { setPassword(""); setConfirmation(""); await utils.auth.me.invalidate(); toast.success("تم تغيير كلمة المرور بنجاح."); if (user?.mustChangePassword) setLocation("/"); }, onError: (error) => toast.error(error.message) });

  if (loading) return <DashboardLayout><div className="grid min-h-[55vh] place-items-center"><Loader2 className="h-8 w-8 animate-spin text-[#F5B800]" /></div></DashboardLayout>;
  if (!isAuthenticated || !user) return null;
  const mustChange = user.mustChangePassword;

  return <DashboardLayout><main className="mx-auto max-w-4xl space-y-6 pb-12" dir="rtl"><header className="rounded-[26px] border border-[#F5B800]/20 bg-[#111823]/85 p-6 shadow-panel"><div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"><div><div className="flex items-center gap-2 text-sm font-bold text-[#F5B800]"><ShieldCheck className="h-4 w-4" />الحساب والأمان</div><h1 className="mt-2 text-2xl font-extrabold text-white">المعلومات الشخصية وبيانات الدخول</h1><p className="mt-2 text-sm leading-7 text-slate-400">حدّث اسمك وكلمة مرورك. لا يُعرض رقم الهوية أو كلمة المرور المؤقتة داخل أي صفحة من PowerHub.</p></div><Badge className={mustChange ? "w-fit bg-amber-400/10 text-amber-200" : "w-fit bg-emerald-400/10 text-emerald-200"}>{mustChange ? "يلزم تغيير كلمة المرور" : "الحساب مؤمّن"}</Badge></div>{mustChange && <div className="mt-5 rounded-xl border border-amber-300/20 bg-amber-300/10 p-4 text-sm leading-7 text-amber-100">هذه كلمة مرور مؤقتة عيّنها آدمن المنصة. غيّرها الآن قبل الوصول إلى المحطات أو الفواتير أو التحصيل.</div>}</header><div className="grid gap-6 lg:grid-cols-2"><Card className="border-white/8 bg-[#111823] shadow-panel"><CardContent className="p-5"><div className="flex items-center gap-3"><UserRound className="h-5 w-5 text-[#F5B800]" /><div><h2 className="font-bold text-white">المعلومات الشخصية</h2><p className="mt-1 text-sm text-slate-500">البريد يُدار من لوحة Supabase ولا يمكن تغييره من PowerHub.</p></div></div><form className="mt-6 space-y-4" onSubmit={(event: FormEvent) => { event.preventDefault(); updateProfile.mutate({ name }); }}><div className="space-y-2"><Label htmlFor="profile-name" className="text-slate-300">الاسم</Label><Input id="profile-name" required minLength={2} value={name} onChange={(event) => setName(event.target.value)} className={inputClass} /></div><div className="space-y-2"><Label htmlFor="profile-email" className="text-slate-300">البريد الإلكتروني</Label><Input id="profile-email" readOnly dir="ltr" value={user.email ?? ""} className={inputClass + " cursor-not-allowed opacity-70"} /></div><Button disabled={updateProfile.isPending} type="submit" variant="outline" className="w-full border-white/10 text-white hover:bg-white/5 hover:text-white">{updateProfile.isPending ? "جارٍ الحفظ…" : "حفظ المعلومات"}</Button></form></CardContent></Card><Card className="border-[#F5B800]/20 bg-[#111823] shadow-panel"><CardContent className="p-5"><div className="flex items-center gap-3"><KeyRound className="h-5 w-5 text-[#F5B800]" /><div><h2 className="font-bold text-white">تغيير كلمة المرور</h2><p className="mt-1 text-sm text-slate-500">اختر كلمة مرور لا تقل عن 8 رموز ولا تشاركها مع أي شخص.</p></div></div><form className="mt-6 space-y-4" onSubmit={(event: FormEvent) => { event.preventDefault(); if (password !== confirmation) return toast.error("تأكيد كلمة المرور غير مطابق."); updatePassword.mutate({ password }); }}><div className="space-y-2"><Label htmlFor="new-password" className="text-slate-300">كلمة المرور الجديدة</Label><Input id="new-password" required minLength={8} type="password" dir="ltr" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} className={inputClass} /></div><div className="space-y-2"><Label htmlFor="confirm-password" className="text-slate-300">تأكيد كلمة المرور الجديدة</Label><Input id="confirm-password" required minLength={8} type="password" dir="ltr" autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} className={inputClass} /></div><Button disabled={updatePassword.isPending} type="submit" className="w-full bg-[#F5B800] font-bold text-[#0D1117] hover:bg-[#ffd23f]">{updatePassword.isPending ? "جارٍ التحديث…" : mustChange ? "تفعيل الحساب بكلمة مرور جديدة" : "تغيير كلمة المرور"}</Button></form></CardContent></Card></div></main></DashboardLayout>;
}
