import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";

/** shadcn base-nova Tabs slots, styled with Lina's existing CSS. */
export function Tabs({
	orientation = "horizontal",
	...props
}: TabsPrimitive.Root.Props) {
	return (
		<TabsPrimitive.Root data-slot="tabs" orientation={orientation} {...props} />
	);
}

export function TabsList(props: TabsPrimitive.List.Props) {
	return <TabsPrimitive.List data-slot="tabs-list" {...props} />;
}

export function TabsTrigger(props: TabsPrimitive.Tab.Props) {
	return <TabsPrimitive.Tab data-slot="tabs-trigger" {...props} />;
}
