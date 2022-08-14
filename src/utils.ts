export async function timer(time: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, time));
}
