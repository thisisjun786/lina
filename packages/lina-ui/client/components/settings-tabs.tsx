import { SETTINGS_TABS, type SettingsTab } from "../settings-tab-model.ts";
import { SettingsIcon } from "./icons.tsx";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs.tsx";

const labels: Record<SettingsTab, string> = {
	general: "일반",
	connections: "프로바이더 연결",
	models: "역할별 모델",
};

function SettingsTabIcon({ tab }: { tab: SettingsTab }) {
	if (tab === "general") return <SettingsIcon />;
	return (
		<svg viewBox="0 0 24 24" aria-hidden="true">
			{tab === "connections" ? (
				<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2" />
			) : (
				<>
					<rect x="5" y="5" width="14" height="14" rx="3" />
					<path d="M9 9h6v6H9zM9 2v3m6-3v3M9 19v3m6-3v3M2 9h3m14 0h3M2 15h3m14 0h3" />
				</>
			)}
		</svg>
	);
}

export function SettingsTabsView({
	value,
	orientation,
	label,
	select,
}: {
	value: SettingsTab;
	orientation: "horizontal" | "vertical";
	label: string;
	select: (tab: SettingsTab) => void;
}) {
	return (
		<Tabs
			value={value}
			orientation={orientation}
			onValueChange={(next) => {
				const tab = SETTINGS_TABS.find((id) => id === next);
				if (tab) select(tab);
			}}
			render={
				<TabsList
					className="ui-tabs-list"
					aria-label={label}
					aria-orientation={orientation}
					activateOnFocus
				/>
			}
			style={{
				flexDirection: orientation === "vertical" ? "column" : "row",
			}}
		>
			{SETTINGS_TABS.map((tab) => (
				<TabsTrigger
					key={tab}
					value={tab}
					id={`settings-tab-${tab}`}
					aria-controls={`settings-panel-${tab}`}
				>
					<SettingsTabIcon tab={tab} />
					<span>{labels[tab]}</span>
				</TabsTrigger>
			))}
		</Tabs>
	);
}
