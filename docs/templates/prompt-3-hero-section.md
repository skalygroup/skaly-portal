# Prompt 3: Hero Section with Header Integration

You are given a task to integrate an existing React component in the codebase

The codebase should support:
- shadcn project structure  
- Tailwind CSS
- Typescript

If it doesn't, provide instructions on how to setup project via shadcn CLI, install Tailwind or Typescript.

Determine the default path for components and styles. 
If default path for components is not /components/ui, provide instructions on why it's important to create this folder

Copy-paste this component to /components/ui folder:

```tsx
// hero-3.tsx
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ArrowRightIcon, PhoneCallIcon } from "lucide-react";

export function HeroSection() {
	return (
		<section className="mx-auto w-full max-w-5xl overflow-hidden pt-16">
			{/* Shades */}
			<div
				aria-hidden="true"
				className="absolute inset-0 size-full overflow-hidden"
			>
				<div
					className={cn(
						"absolute inset-0 isolate -z-10",
						"bg-[radial-gradient(20%_80%_at_20%_0%,--theme(--color-foreground/.1),transparent)]"
					)}
				/>
			</div>
			<div className="relative z-10 flex max-w-2xl flex-col gap-5 px-4">
				<a
					className={cn(
						"group flex w-fit items-center gap-3 rounded-sm border bg-card p-1 shadow-xs",
						"fade-in slide-in-from-bottom-10 animate-in fill-mode-backwards transition-all delay-500 duration-500 ease-out"
					)}
					href="#link"
				>
					<div className="rounded-xs border bg-card px-1.5 py-0.5 shadow-sm">
						<p className="font-mono text-xs">NOW</p>
					</div>

					<span className="text-xs">accepting new client projects</span>
					<span className="block h-5 border-l" />

					<div className="pr-1">
						<ArrowRightIcon className="size-3 -translate-x-0.5 duration-150 ease-out group-hover:translate-x-0.5" />
					</div>
				</a>

				<h1
					className={cn(
						"text-balance font-medium text-4xl text-foreground leading-tight md:text-5xl",
						"fade-in slide-in-from-bottom-10 animate-in fill-mode-backwards delay-100 duration-500 ease-out"
					)}
				>
					Building Digital Experiences That Drive Growth
				</h1>

				<p
					className={cn(
						"text-muted-foreground text-sm tracking-wider sm:text-lg md:text-xl",
						"fade-in slide-in-from-bottom-10 animate-in fill-mode-backwards delay-200 duration-500 ease-out"
					)}
				>
					We help brands scale faster through design, development <br /> and
					strategic execution.
				</p>

				<div className="fade-in slide-in-from-bottom-10 flex w-fit animate-in items-center justify-center gap-3 fill-mode-backwards pt-2 delay-300 duration-500 ease-out">
					<Button variant="outline">
						<PhoneCallIcon className="size-4 mr-2" data-icon="inline-start" />{" "}
						Book a Call
					</Button>
					<Button>
						Get started{" "}
						<ArrowRightIcon className="size-4 ml-2" data-icon="inline-end" />
					</Button>
				</div>
			</div>
			<div className="relative">
				<div
					className={cn(
						"absolute -inset-x-20 inset-y-0 -translate-y-1/3 scale-120 rounded-full",
						"bg-[radial-gradient(ellipse_at_center,theme(--color-foreground/.1),transparent,transparent)]",
						"blur-[50px]"
					)}
				/>
				<div
					className={cn(
						"mask-b-from-60% relative mt-8 -mr-56 overflow-hidden px-2 sm:mt-12 sm:mr-0 md:mt-20",
						"fade-in slide-in-from-bottom-5 animate-in fill-mode-backwards delay-100 duration-1000 ease-out"
					)}
				>
					<div className="relative inset-shadow-2xs inset-shadow-foreground/10 mx-auto max-w-5xl overflow-hidden rounded-lg border bg-background p-2 shadow-xl ring-1 ring-card dark:inset-shadow-foreground/20 dark:inset-shadow-xs">
						<img
							alt="app screen"
							className="z-2 aspect-video rounded-lg border dark:hidden"
							height="1080"
							src="https://storage.efferd.com/screen/dashboard-light.webp"
							width="1920"
						/>
						<img
							alt="app screen"
							className="hidden aspect-video rounded-lg bg-background dark:block"
							height="1080"
							src="https://storage.efferd.com/screen/dashboard-dark.webp"
							width="1920"
						/>
					</div>
				</div>
			</div>
		</section>
	);
}
```

```tsx
// demo.tsx
import { HeroSection } from "@/components/ui/hero-3";
import { Header } from "@/components/ui/header-3"; // @efferd/header-3

export default function DemoOne() {
	return (
		<div className="flex w-full flex-col">
		<Header />
		  <main className="grow" >
			<HeroSection />
	      </main>
	   </div>
  );
}
```

Copy-paste these files for dependencies:

```tsx
// shadcn/button
import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        outline:
          "border border-input bg-background hover:bg-accent hover:text-accent-foreground",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-9 rounded-md px-3",
        lg: "h-11 rounded-md px-8",
        icon: "h-10 w-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button"
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    )
  },
)
Button.displayName = "Button"

export { Button, buttonVariants }
```

```tsx
// sshahaider/header-3
'use client';
import React from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { MenuToggleIcon } from '@/components/ui/menu-toggle-icon';
import { createPortal } from 'react-dom';
import {
	NavigationMenu,
	NavigationMenuContent,
	NavigationMenuItem,
	NavigationMenuLink,
	NavigationMenuList,
	NavigationMenuTrigger,
} from '@/components/ui/navigation-menu';
import { LucideIcon } from 'lucide-react';
import {
	CodeIcon,
	GlobeIcon,
	LayersIcon,
	UserPlusIcon,
	Users,
	Star,
	FileText,
	Shield,
	RotateCcw,
	Handshake,
	Leaf,
	HelpCircle,
	BarChart,
	PlugIcon,
} from 'lucide-react';

type LinkItem = {
	title: string;
	href: string;
	icon: LucideIcon;
	description?: string;
};

export function Header() {
	const [open, setOpen] = React.useState(false);
	const scrolled = useScroll(10);

	React.useEffect(() => {
		if (open) {
			document.body.style.overflow = 'hidden';
		} else {
			document.body.style.overflow = '';
		}
		return () => {
			document.body.style.overflow = '';
		};
	}, [open]);

	return (
		<header
			className={cn('sticky top-0 z-50 w-full border-b border-transparent', {
				'bg-background/95 supports-[backdrop-filter]:bg-background/50 border-border backdrop-blur-lg':
					scrolled,
			})}
		>
			<nav className="mx-auto flex h-14 w-full max-w-5xl items-center justify-between px-4">
				<div className="flex items-center gap-5">
					<a href="#" className="hover:bg-accent rounded-md p-2">
						<WordmarkIcon className="h-4" />
					</a>
					<NavigationMenu className="hidden md:flex">
						<NavigationMenuList>
							<NavigationMenuItem>
								<NavigationMenuTrigger className="bg-transparent">Product</NavigationMenuTrigger>
								<NavigationMenuContent className="bg-background p-1 pr-1.5">
									<ul className="bg-popover grid w-lg grid-cols-2 gap-2 rounded-md border p-2 shadow">
										{productLinks.map((item, i) => (
											<li key={i}>
												<ListItem {...item} />
											</li>
										))}
									</ul>
									<div className="p-2">
										<p className="text-muted-foreground text-sm">
											Interested?{' '}
											<a href="#" className="text-foreground font-medium hover:underline">
												Schedule a demo
											</a>
										</p>
									</div>
								</NavigationMenuContent>
							</NavigationMenuItem>
							<NavigationMenuItem>
								<NavigationMenuTrigger className="bg-transparent">Company</NavigationMenuTrigger>
								<NavigationMenuContent className="bg-background p-1 pr-1.5 pb-1.5">
									<div className="grid w-lg grid-cols-2 gap-2">
										<ul className="bg-popover space-y-2 rounded-md border p-2 shadow">
											{companyLinks.map((item, i) => (
												<li key={i}>
													<ListItem {...item} />
												</li>
											))}
										</ul>
										<ul className="space-y-2 p-3">
											{companyLinks2.map((item, i) => (
												<li key={i}>
													<NavigationMenuLink
														href={item.href}
														className="flex p-2 hover:bg-accent flex-row rounded-md items-center gap-x-2"
													>
														<item.icon className="text-foreground size-4" />
														<span className="font-medium">{item.title}</span>
													</NavigationMenuLink>
												</li>
											))}
										</ul>
									</div>
								</NavigationMenuContent>
							</NavigationMenuItem>
							<NavigationMenuLink className="px-4" asChild>
								<a href="#" className="hover:bg-accent rounded-md p-2">
									Pricing
								</a>
							</NavigationMenuLink>
						</NavigationMenuList>
					</NavigationMenu>
				</div>
				<div className="hidden items-center gap-2 md:flex">
					<Button variant="outline">Sign In</Button>
					<Button>Get Started</Button>
				</div>
				<Button
					size="icon"
					variant="outline"
					onClick={() => setOpen(!open)}
					className="md:hidden"
					aria-expanded={open}
					aria-controls="mobile-menu"
					aria-label="Toggle menu"
				>
					<MenuToggleIcon open={open} className="size-5" duration={300} />
				</Button>
			</nav>
			<MobileMenu open={open} className="flex flex-col justify-between gap-2 overflow-y-auto">
				<NavigationMenu className="max-w-full">
					<div className="flex w-full flex-col gap-y-2">
						<span className="text-sm">Product</span>
						{productLinks.map((link) => (
							<ListItem key={link.title} {...link} />
						))}
						<span className="text-sm">Company</span>
						{companyLinks.map((link) => (
							<ListItem key={link.title} {...link} />
						))}
						{companyLinks2.map((link) => (
							<ListItem key={link.title} {...link} />
						))}
					</div>
				</NavigationMenu>
				<div className="flex flex-col gap-2">
					<Button variant="outline" className="w-full bg-transparent">
						Sign In
					</Button>
					<Button className="w-full">Get Started</Button>
				</div>
			</MobileMenu>
		</header>
	);
}

// ... (MobileMenu, ListItem, product/company link arrays, useScroll hook, and WordmarkIcon as provided in original source)
```

```tsx
// shadcn/navigation-menu
// (Full NavigationMenu component — see original source for complete implementation)
// Key exports: NavigationMenu, NavigationMenuList, NavigationMenuItem,
// NavigationMenuContent, NavigationMenuTrigger, NavigationMenuLink,
// NavigationMenuIndicator, NavigationMenuViewport, navigationMenuTriggerStyle
```

```tsx
// sshahaider/menu-toggle-icon
'use client';
import React from 'react';
import { cn } from '@/lib/utils';

type MenuToggleProps = React.ComponentProps<'svg'> & {
	open: boolean;
	duration?: number;
};

export function MenuToggleIcon({
	open,
	className,
	fill = 'none',
	stroke = 'currentColor',
	strokeWidth = 2.5,
	strokeLinecap = 'round',
	strokeLinejoin = 'round',
	duration = 500,
	...props
}: MenuToggleProps) {
	return (
		<svg
			strokeWidth={strokeWidth}
			fill={fill}
			stroke={stroke}
			viewBox="0 0 32 32"
			strokeLinecap={strokeLinecap}
			strokeLinejoin={strokeLinejoin}
			className={cn(
				'transition-transform ease-in-out',
				open && '-rotate-45',
				className,
			)}
			style={{
				transitionDuration: `${duration}ms`,
			}}
			{...props}
		>
			<path
				className={cn(
					'transition-all ease-in-out',
					open
						? '[stroke-dasharray:20_300] [stroke-dashoffset:-32.42px]'
						: '[stroke-dasharray:12_63]',
				)}
				style={{
					transitionDuration: `${duration}ms`,
				}}
				d="M27 10 13 10C10.8 10 9 8.2 9 6 9 3.5 10.8 2 13 2 15.2 2 17 3.8 17 6L17 26C17 28.2 18.8 30 21 30 23.2 30 25 28.2 25 26 25 23.8 23.2 22 21 22L7 22"
			/>
			<path d="M7 16 27 16" />
		</svg>
	);
}
```

## Install NPM Dependencies

```bash
lucide-react @radix-ui/react-slot class-variance-authority @radix-ui/react-icons @radix-ui/react-navigation-menu
```
