import chalk from "chalk";

export function errorNotification(errorText: string): string {
  return chalk.red(errorText);
}

export function successNotification(successText: string): string {
  return chalk.green(successText);
}

export function successBGNotification(successText: string): string {
  return chalk.bgGreen(successText);
}